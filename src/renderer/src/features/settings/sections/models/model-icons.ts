import openaiIcon from '../../../../../../public/model-icons/openai.png'
import googleIcon from '../../../../../../public/model-icons/google.png'
import claudeIcon from '../../../../../../public/model-icons/claude.png'
import deepseekIcon from '../../../../../../public/model-icons/deepseek.png'
import mistralIcon from '../../../../../../public/model-icons/mistral.png'
import nvidiaIcon from '../../../../../../public/model-icons/nvidia.png'
import kimiIcon from '../../../../../../public/model-icons/kimi.jpg'
import minimaxIcon from '../../../../../../public/model-icons/minimax.jpg'
import xiaomiIcon from '../../../../../../public/model-icons/xiaomi.png'
import metaIcon from '../../../../../../public/model-icons/meta.png'
import longcatIcon from '../../../../../../public/model-icons/longcat.png'
import zaiIcon from '../../../../../../public/model-icons/zai.svg'
import starkIconUrl from '../../../../../../public/starkicon.png'

/**
 * Central model icon registry (Settings → Models).
 *
 * ONE mapping from STABLE MODEL ID to bundled local image URL — shared
 * by the Model Library cards and both LoopLink rosters. Never map by
 * display name. All assets are verified official provider/model marks
 * downloaded from first-party sources (see model-icon-sources.md);
 * offline, packaged with STARK. No remote URLs, no runtime fetching.
 *
 * Trademarks belong to their respective owners; STARK displays each
 * mark only beside that provider's own model name and claims no
 * ownership. Unknown ids resolve to the neutral STARK fallback.
 */

/** Neutral STARK fallback for unknown ids and load failures. */
export const MODEL_FALLBACK_ICON: string = starkIconUrl

/** Stable-id → bundled official image URL for the 15 locked Free models. */
export const MODEL_ICON_BY_ID: Readonly<Record<string, string>> = {
  'builtin:muse-spark-1.3': metaIcon,
  'builtin:glm-5.3-flash': zaiIcon,
  'builtin:deepseek-v4.1-flash': deepseekIcon,
  'builtin:gpt-5.6-luna': openaiIcon,
  'builtin:gemini-2.5-flash': googleIcon,
  'builtin:claude-haiku-5.5': claudeIcon,
  'builtin:minimax-m3': minimaxIcon,
  'builtin:kimi-k2.7-code': kimiIcon,
  'builtin:mimo-v2.6-pro': xiaomiIcon,
  'builtin:mimo-v2.6-flash': xiaomiIcon,
  'builtin:nemotron-3.5-lightning': nvidiaIcon,
  'builtin:deepseek-v4-flash': deepseekIcon,
  'builtin:muse-spark-1.2': metaIcon,
  'builtin:longcat-2.0': longcatIcon,
  'builtin:mistral-large-4': mistralIcon
}

/** Image URL for one stable model id, or the fallback when unknown. */
export function modelIconFor(stableId: string): string {
  return MODEL_ICON_BY_ID[stableId] ?? MODEL_FALLBACK_ICON
}
