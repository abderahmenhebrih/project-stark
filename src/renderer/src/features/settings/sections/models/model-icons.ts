import museSpark13Icon from '../../../../../../public/model-icons/muse-spark-13.png'
import museSpark12Icon from '../../../../../../public/model-icons/muse-spark-12.png'
import glmIcon from '../../../../../../public/model-icons/glm.png'
import deepseekV41Icon from '../../../../../../public/model-icons/deepseek-v41.png'
import deepseekV4Icon from '../../../../../../public/model-icons/deepseek-v4.png'
import gptLunaIcon from '../../../../../../public/model-icons/gpt-luna.png'
import geminiIcon from '../../../../../../public/model-icons/gemini.png'
import claudeIcon from '../../../../../../public/model-icons/claude.png'
import minimaxIcon from '../../../../../../public/model-icons/minimax.png'
import kimiIcon from '../../../../../../public/model-icons/kimi.png'
import mimoProIcon from '../../../../../../public/model-icons/mimo-pro.png'
import mimoFlashIcon from '../../../../../../public/model-icons/mimo-flash.png'
import nemotronIcon from '../../../../../../public/model-icons/nemotron.png'
import mistralIcon from '../../../../../../public/model-icons/mistral.png'
import longcatIcon from '../../../../../../public/model-icons/longcat.png'
import fallbackIcon from '../../../../../../public/model-icons/fallback.png'

/**
 * Central model icon registry (Settings → Models).
 *
 * ONE mapping from STABLE MODEL ID to bundled local image URL — shared
 * by the Model Library cards and both LoopLink rosters. Never map by
 * display name. All assets are local full-bleed app-style PNGs
 * (offline, packaged with STARK); no remote URLs, no runtime fetching.
 *
 * The artwork is original STARK-local imagery (see
 * src/public/model-icons/) — NOT official provider logos, and never
 * presented as such. Family pairs (DeepSeek, MiMo, Muse Spark) share
 * an identity with distinct compositions.
 */

/** Generic STARK app-style fallback for unknown ids and load failures. */
export const MODEL_FALLBACK_ICON: string = fallbackIcon

/** Stable-id → bundled image URL for the 15 locked Free models. */
export const MODEL_ICON_BY_ID: Readonly<Record<string, string>> = {
  'builtin:muse-spark-1.3': museSpark13Icon,
  'builtin:glm-5.3-flash': glmIcon,
  'builtin:deepseek-v4.1-flash': deepseekV41Icon,
  'builtin:gpt-5.6-luna': gptLunaIcon,
  'builtin:gemini-2.5-flash': geminiIcon,
  'builtin:claude-haiku-5.5': claudeIcon,
  'builtin:minimax-m3': minimaxIcon,
  'builtin:kimi-k2.7-code': kimiIcon,
  'builtin:mimo-v2.6-pro': mimoProIcon,
  'builtin:mimo-v2.6-flash': mimoFlashIcon,
  'builtin:nemotron-3.5-lightning': nemotronIcon,
  'builtin:deepseek-v4-flash': deepseekV4Icon,
  'builtin:muse-spark-1.2': museSpark12Icon,
  'builtin:longcat-2.0': longcatIcon,
  'builtin:mistral-large-4': mistralIcon
}

/** Image URL for one stable model id, or the fallback when unknown. */
export function modelIconFor(stableId: string): string {
  return MODEL_ICON_BY_ID[stableId] ?? MODEL_FALLBACK_ICON
}
