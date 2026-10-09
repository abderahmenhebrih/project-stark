import { Component, type ReactElement, type ReactNode } from 'react'
import {
  DISPLAY_ERROR_MESSAGE,
  DISPLAY_ERROR_RELOAD_LABEL,
  errorBoundaryStateFor,
  initialErrorBoundaryState
} from './error-boundary-state'

interface ErrorBoundaryProps {
  readonly children: ReactNode
  readonly onQuit?: () => void
}

interface ErrorBoundaryComponentState {
  readonly hasError: boolean
}

/**
 * Top-level React Error Boundary (Stage 30).
 *
 * A renderer crash shows a safe message with Reload interface (and an
 * optional Quit action). Reloading re-renders only: it never restarts
 * managed runtimes, resends AI requests, re-executes commands,
 * re-approves actions, or duplicates transactions — those live in the
 * main process and are untouched by a renderer remount. Raw stacks
 * never render; the console keeps developer diagnostics.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryComponentState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = initialErrorBoundaryState()
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryComponentState {
    return errorBoundaryStateFor(error)
  }

  override componentDidCatch(error: unknown, info: unknown): void {
    void error
    void info
  }

  private handleReload = (): void => {
    this.setState(initialErrorBoundaryState())
  }

  override render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children
    }
    const reloadButton: ReactElement = (
      <button className="error-boundary__reload" type="button" onClick={this.handleReload}>
        {DISPLAY_ERROR_RELOAD_LABEL}
      </button>
    )
    if (this.props.onQuit === undefined) {
      return (
        <div className="error-boundary" role="alert">
          <p className="error-boundary__message">{DISPLAY_ERROR_MESSAGE}</p>
          {reloadButton}
        </div>
      )
    }
    const quit = this.props.onQuit
    return (
      <div className="error-boundary" role="alert">
        <p className="error-boundary__message">{DISPLAY_ERROR_MESSAGE}</p>
        {reloadButton}
        <button className="error-boundary__quit" type="button" onClick={quit}>
          Quit
        </button>
      </div>
    )
  }
}
