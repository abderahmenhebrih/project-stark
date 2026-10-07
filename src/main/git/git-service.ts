import { realpath, stat } from 'node:fs/promises'
import { relative } from 'node:path'
import type { GitDiffResult, GitFileStatus, GitWorkspaceState } from '../../shared/git/types'
import {
  classifyGitStderr,
  GitNotRepositoryError,
  GitPathNotInStatusError,
  GitRootMismatchError,
  GitSafeDirectoryError,
  GitStatusTooLargeError,
  GitUnavailableError,
  GitUntrackedNoDiffError,
  GitUnsupportedRepositoryError,
  GitWorkspaceUnavailableError,
  InvalidGitRequestError
} from './errors'
import { normalizeGitPathForComparison, validateGitRelativePath } from './git-path'
import {
  buildBranchInfo,
  parseAheadBehind,
  parseHeadShort,
  parsePorcelainV1Z,
  parseSymbolicRef,
  parseUpstream
} from './git-parser'
import type { GitProcessRunner } from './git-process-runner'
import {
  GIT_COMMAND_TIMEOUT_MS,
  MAX_GIT_DIFF_OUTPUT_BYTES,
  MAX_GIT_FILES,
  MAX_GIT_STATUS_OUTPUT_BYTES
} from './limits'
import type { WorkspaceRepository } from '../database/repositories/workspace-repository'

/**
 * Read-only Git domain service (Stage 12).
 *
 * Responsibilities: availability, repository-root validation,
 * branch/upstream/ahead-behind, status, and staged/unstaged diffs with
 * safe error translation. Depends on WorkspaceRepository (persisted
 * root authority) and GitProcessRunner (bounded execution). No UI
 * concerns, no persistence, no mutation commands anywhere.
 */

function isValidId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function foldsCase(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin'
}

function canonicalEqual(left: string, right: string): boolean {
  if (foldsCase()) {
    return left.toLowerCase() === right.toLowerCase()
  }
  return left === right
}

function hasStrictShape(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      return false
    }
  }
  return true
}

export interface GitRunnerLike {
  runGit(options: {
    readonly cwd: string
    readonly args: readonly string[]
    readonly timeoutMs?: number
    readonly maxOutputBytes: number
    readonly overflowKind?: 'status' | 'diff'
  }): Promise<{ readonly exitCode: number | null; readonly stdout: Buffer; readonly stderr: Buffer }>
}

export class GitService {
  private availabilityCache: boolean | null = null

  constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly runner: GitRunnerLike
  ) {}

  /** For tests: clear the in-memory availability cache. */
  clearAvailabilityCache(): void {
    this.availabilityCache = null
  }

  private async resolveWorkspaceRoot(workspaceId: number): Promise<string> {
    const stored = this.workspaces.findById(workspaceId)
    if (stored === undefined) {
      throw new GitWorkspaceUnavailableError()
    }
    try {
      const stats = await stat(stored.rootPath)
      if (!stats.isDirectory()) {
        throw new GitWorkspaceUnavailableError()
      }
      return await realpath(stored.rootPath)
    } catch (error) {
      if (error instanceof GitWorkspaceUnavailableError) {
        throw error
      }
      throw new GitWorkspaceUnavailableError({ cause: error })
    }
  }

  private async checkAvailable(cwd: string): Promise<boolean> {
    if (this.availabilityCache !== null) {
      return this.availabilityCache
    }
    try {
      const result = await this.runner.runGit({
        cwd,
        args: ['--no-pager', '--version'],
        timeoutMs: GIT_COMMAND_TIMEOUT_MS,
        maxOutputBytes: 64 * 1024,
        overflowKind: 'status'
      })
      const available = result.exitCode === 0
      this.availabilityCache = available
      return available
    } catch (error) {
      if (error instanceof GitUnavailableError) {
        this.availabilityCache = false
        return false
      }
      // Timeout/overflow on --version still means "git ran"; treat as
      // available so the real operation can report its own bound.
      // Only ENOENT-style unavailability flips the cache to false.
      throw error
    }
  }

  private throwIfSafeDirectory(stderr: Buffer): void {
    const classification = classifyGitStderr(stderr.toString('utf8'))
    if (classification === 'safe-directory') {
      throw new GitSafeDirectoryError()
    }
  }

  /**
   * Resolves and validates the Git top-level for a canonical workspace
   * root. Returns the canonical top-level. Throws GitNotRepositoryError,
   * GitRootMismatchError, GitSafeDirectoryError, or unsupported errors.
   */
  private async resolveRepositoryTopLevel(canonicalRoot: string): Promise<string> {
    const topLevel = await this.runner.runGit({
      cwd: canonicalRoot,
      args: ['--no-pager', 'rev-parse', '--show-toplevel'],
      timeoutMs: GIT_COMMAND_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024,
      overflowKind: 'status'
    })
    if (topLevel.exitCode !== 0) {
      this.throwIfSafeDirectory(topLevel.stderr)
      const classification = classifyGitStderr(topLevel.stderr.toString('utf8'))
      if (classification === 'not-repository') {
        throw new GitNotRepositoryError()
      }
      throw new GitNotRepositoryError()
    }
    const rawTop = topLevel.stdout.toString('utf8').trim().replace(/\r?\n$/, '')
    if (rawTop === '') {
      throw new GitNotRepositoryError()
    }
    let canonicalTop: string
    try {
      canonicalTop = await realpath(rawTop)
    } catch {
      canonicalTop = rawTop
    }
    // Platform-correct equality: a subfolder inside a parent repo must
    // NOT operate on the parent repository.
    const difference = relative(canonicalRoot, canonicalTop)
    void difference
    if (!canonicalEqual(canonicalTop, canonicalRoot)) {
      // Distinguish "inside a parent repo" from "not a repo": we DID get
      // a top-level, but it is not the workspace root.
      throw new GitRootMismatchError()
    }
    // Bare / non-working-tree repositories are unsupported in Stage 12.
    const bare = await this.runner.runGit({
      cwd: canonicalRoot,
      args: ['--no-pager', 'rev-parse', '--is-bare-repository'],
      timeoutMs: GIT_COMMAND_TIMEOUT_MS,
      maxOutputBytes: 1024,
      overflowKind: 'status'
    })
    if (bare.exitCode === 0 && bare.stdout.toString('utf8').trim() === 'true') {
      throw new GitUnsupportedRepositoryError()
    }
    const workTree = await this.runner.runGit({
      cwd: canonicalRoot,
      args: ['--no-pager', 'rev-parse', '--is-inside-work-tree'],
      timeoutMs: GIT_COMMAND_TIMEOUT_MS,
      maxOutputBytes: 1024,
      overflowKind: 'status'
    })
    if (workTree.exitCode === 0 && workTree.stdout.toString('utf8').trim() !== 'true') {
      throw new GitUnsupportedRepositoryError()
    }
    return canonicalTop
  }

  private async readBranch(cwd: string): Promise<ReturnType<typeof buildBranchInfo>> {
    const symbolic = await this.runner.runGit({
      cwd,
      args: ['--no-pager', 'symbolic-ref', '--quiet', '--short', 'HEAD'],
      timeoutMs: GIT_COMMAND_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024,
      overflowKind: 'status'
    })
    const symbolicName = parseSymbolicRef(symbolic.exitCode, symbolic.stdout.toString('utf8'))
    let headShort: string | null
    if (symbolicName !== null) {
      // Normal branch: still resolve HEAD hash when available (unborn
      // branches have no HEAD; that is normal, not an error).
      const head = await this.runner.runGit({
        cwd,
        args: ['--no-pager', 'rev-parse', '--short=12', 'HEAD'],
        timeoutMs: GIT_COMMAND_TIMEOUT_MS,
        maxOutputBytes: 1024,
        overflowKind: 'status'
      })
      headShort = parseHeadShort(head.exitCode, head.stdout.toString('utf8'))
    } else {
      const head = await this.runner.runGit({
        cwd,
        args: ['--no-pager', 'rev-parse', '--short=12', 'HEAD'],
        timeoutMs: GIT_COMMAND_TIMEOUT_MS,
        maxOutputBytes: 1024,
        overflowKind: 'status'
      })
      headShort = parseHeadShort(head.exitCode, head.stdout.toString('utf8'))
      if (headShort === null) {
        return buildBranchInfo({ symbolicName: null, headShort: null, upstream: null, aheadBehind: null })
      }
    }
    if (headShort === null && symbolicName !== null) {
      // Unborn branch: no commits yet — upstream/ahead-behind are null.
      return buildBranchInfo({ symbolicName, headShort: null, upstream: null, aheadBehind: null })
    }
    const upstreamResult = await this.runner.runGit({
      cwd,
      args: ['--no-pager', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      timeoutMs: GIT_COMMAND_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024,
      overflowKind: 'status'
    })
    const upstream = parseUpstream(upstreamResult.exitCode, upstreamResult.stdout.toString('utf8'))
    if (upstream === null) {
      return buildBranchInfo({ symbolicName, headShort, upstream: null, aheadBehind: null })
    }
    // Values reflect only locally available refs (no fetch).
    const counts = await this.runner.runGit({
      cwd,
      args: ['--no-pager', 'rev-list', '--left-right', '--count', 'HEAD...@{upstream}'],
      timeoutMs: GIT_COMMAND_TIMEOUT_MS,
      maxOutputBytes: 1024,
      overflowKind: 'status'
    })
    if (counts.exitCode !== 0) {
      return buildBranchInfo({ symbolicName, headShort, upstream, aheadBehind: null })
    }
    const aheadBehind = parseAheadBehind(counts.stdout.toString('utf8'))
    return buildBranchInfo({ symbolicName, headShort, upstream, aheadBehind })
  }

  private async readStatus(cwd: string): Promise<readonly GitFileStatus[]> {
    const status = await this.runner.runGit({
      cwd,
      args: ['--no-pager', 'status', '--porcelain=v1', '-z', '--untracked-files=normal'],
      timeoutMs: GIT_COMMAND_TIMEOUT_MS,
      maxOutputBytes: MAX_GIT_STATUS_OUTPUT_BYTES,
      overflowKind: 'status'
    })
    if (status.exitCode !== 0) {
      this.throwIfSafeDirectory(status.stderr)
      throw new GitNotRepositoryError()
    }
    const files = parsePorcelainV1Z(status.stdout)
    if (files.length > MAX_GIT_FILES) {
      throw new GitStatusTooLargeError()
    }
    return files
  }

  /**
   * Fixed get-status operation: availability → repository detection →
   * root validation → branch/upstream → bounded status. Single attempt
   * per Git invocation; failures map to safe states/errors with no
   * retries.
   */
  async getStatus(payload: unknown): Promise<GitWorkspaceState> {
    if (!hasStrictShape(payload, ['workspaceId'])) {
      throw new InvalidGitRequestError('Git status request is invalid')
    }
    const { workspaceId } = payload
    if (!isValidId(workspaceId)) {
      throw new InvalidGitRequestError('workspace reference is invalid')
    }
    const canonicalRoot = await this.resolveWorkspaceRoot(workspaceId)
    const available = await this.checkAvailable(canonicalRoot)
    if (!available) {
      return { kind: 'unavailable' }
    }
    let canonicalTop: string
    try {
      canonicalTop = await this.resolveRepositoryTopLevel(canonicalRoot)
    } catch (error) {
      if (error instanceof GitNotRepositoryError) {
        return { kind: 'not-repository' }
      }
      if (error instanceof GitRootMismatchError) {
        return { kind: 'root-mismatch' }
      }
      throw error
    }
    void canonicalTop
    const branch = await this.readBranch(canonicalRoot)
    const files = await this.readStatus(canonicalRoot)
    return { kind: 'ready', workspaceId, clean: files.length === 0, branch, files }
  }

  /**
   * Fixed get-diff operation: validates the narrow request, enforces
   * status-membership authority (no renderer-invented pathspecs),
   * refuses untracked files, then runs one fixed bounded diff with
   * --no-ext-diff --no-textconv --no-color.
   */
  async getDiff(payload: unknown): Promise<GitDiffResult> {
    if (!hasStrictShape(payload, ['workspaceId', 'relativePath', 'target'])) {
      throw new InvalidGitRequestError('Git diff request is invalid')
    }
    const record = payload as Record<string, unknown>
    const { workspaceId, relativePath, target } = record
    if (!isValidId(workspaceId)) {
      throw new InvalidGitRequestError('workspace reference is invalid')
    }
    if (target !== 'staged' && target !== 'unstaged') {
      throw new InvalidGitRequestError('Git diff target is invalid')
    }
    const validatedPath = validateGitRelativePath(relativePath)
    const canonicalRoot = await this.resolveWorkspaceRoot(workspaceId as number)
    const available = await this.checkAvailable(canonicalRoot)
    if (!available) {
      throw new GitUnavailableError()
    }
    try {
      await this.resolveRepositoryTopLevel(canonicalRoot)
    } catch (error) {
      if (error instanceof GitNotRepositoryError || error instanceof GitRootMismatchError) {
        throw error
      }
      throw error
    }
    // Status membership authority: the requested path must appear in
    // the current status (either side of a rename). No arbitrary
    // pathspec syntax from the renderer.
    const files = await this.readStatus(canonicalRoot)
    const match = files.find(
      (entry) =>
        normalizeGitPathForComparison(entry.relativePath) === validatedPath ||
        (entry.originalPath !== null && normalizeGitPathForComparison(entry.originalPath) === validatedPath)
    )
    if (match === undefined) {
      throw new GitPathNotInStatusError()
    }
    if (match.untracked) {
      throw new GitUntrackedNoDiffError()
    }
    // For renames, diff the new (current) path.
    const diffPath =
      match.originalPath !== null && normalizeGitPathForComparison(match.originalPath) === validatedPath
        ? match.relativePath
        : validatedPath
    const args =
      target === 'staged'
        ? ([
            '--no-pager',
            'diff',
            '--cached',
            '--no-ext-diff',
            '--no-textconv',
            '--no-color',
            '--unified=3',
            '--',
            diffPath
          ] as const)
        : ([
            '--no-pager',
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--no-color',
            '--unified=3',
            '--',
            diffPath
          ] as const)
    const result = await this.runner.runGit({
      cwd: canonicalRoot,
      args: [...args],
      timeoutMs: GIT_COMMAND_TIMEOUT_MS,
      maxOutputBytes: MAX_GIT_DIFF_OUTPUT_BYTES,
      overflowKind: 'diff'
    })
    if (result.exitCode !== 0) {
      this.throwIfSafeDirectory(result.stderr)
      throw new GitPathNotInStatusError()
    }
    return {
      workspaceId: workspaceId as number,
      relativePath: validatedPath,
      target: target as 'staged' | 'unstaged',
      patch: result.stdout.toString('utf8')
    }
  }
}

// Re-export for the runner-interface test (keeps imports shallow).
export type { GitProcessRunner }
