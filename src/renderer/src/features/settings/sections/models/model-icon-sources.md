# Model Icon Sources (developer provenance record)

Local official provider/model marks bundled with STARK. All assets were
downloaded once during development (2026-10-11) and are served offline
from `src/public/model-icons/`. Trademarks belong to their respective
owners; STARK displays each mark only beside that provider's own model
name and claims no ownership.

| Provider / Model | Local file | Official source URL | Organization | Retrieved | Brand note |
|---|---|---|---|---|---|
| OpenAI (GPT 5.6 Luna) | openai.png | https://github.com/openai (org avatar, blog verifies openai.com) | OpenAI | 2026-10-11 | Blossom mark. Usage: https://openai.com/brand/ — use only with OpenAI services, unmodified. |
| Google (Gemini 2.5 Flash) | google.png | https://github.com/google (org avatar, blog verifies opensource.google) | Google | 2026-10-11 | "G" mark. Google brand permissions apply. |
| Anthropic (Claude Haiku 5.5) | claude.png | https://claude.ai/favicon.ico (official Claude product icon, carved PNG entry from first-party ICO) | Anthropic | 2026-10-11 | Orange Claude starburst mark. The anthropics org "A" monogram was replaced per QA: Claude models use the Claude mark. |
| DeepSeek (V4.1 Flash, V4 Flash) | deepseek.png | https://github.com/deepseek-ai (org avatar, blog verifies deepseek.com) | DeepSeek | 2026-10-11 | Blue whale mark. |
| Mistral AI (Mistral Large 4) | mistral.png | https://github.com/mistralai (org avatar, blog verifies mistral.ai) | Mistral AI | 2026-10-11 | "M" mark on brand gradient. First-party wordmark lockup at https://mistral.ai/images/logos/logo-mistral.svg was rejected (contains wordmark text). |
| NVIDIA (Nemotron 3.5 Lightning) | nvidia.png | https://github.com/NVIDIA (org avatar, blog verifies nvidia.com) | NVIDIA | 2026-10-11 | Green eye mark. The black wordmark at nvidia.com was rejected (unreadable on dark UI). |
| Moonshot AI (Kimi K2.7 Code) | kimi.jpg | https://github.com/MoonshotAI (org avatar, blog verifies moonshot.ai) | Moonshot AI | 2026-10-11 | "K" moon mark. Official brand guide: https://moonshotai.github.io/Branding-Guide/ |
| MiniMax (MiniMax M3) | minimax.jpg | https://github.com/minimax-ai (org avatar, blog verifies minimax.io) | MiniMax | 2026-10-11 | Official waveform lockup. EXCEPTION: contains "MINIMAX" wordmark text (no mark-only variant published; favicons reuse the same lockup). Kept for authenticity over the no-text rule; text is ~7px at roster size. |
| Xiaomi (MiMo-V2.6-Pro, MiMo-V2.6-Flash) | xiaomi.png | https://github.com/Xiaomi (org avatar, blog verifies mi.com) | Xiaomi | 2026-10-11 | Orange "Mi" mark. MiMo models are Xiaomi's (verified via catalog provider label, no conflicting evidence found). |
| Meta (Muse Spark 1.3, Muse Spark 1.2) | meta.png | https://github.com/facebook (org avatar, Meta's official GitHub org) | Meta | 2026-10-11 | Infinity-loop mark. Muse Spark verified as Meta Superintelligence Labs family (ai.meta.com/blog 2026-04-08; research.meta.ai Muse Spark 1.3 2026-09-02). No per-model mark published; provider mark used. |
| LongCat (LongCat 2.0) | longcat.png | https://github.com/meituan-longcat (org avatar for the LongCat-2.0 repo org) | Meituan LongCat | 2026-10-11 | Green "M" cat-face mark. LongCat-2.0 verified at longcat.ai + Meituan repo (MIT weights). |
| Z.AI / Zhipu (GLM-5.3 Flash) | zai.svg | https://z-cdn.chatglm.cn/z-ai/static/logo.svg (linked from https://z.ai/) | Zhipu AI (Z.AI) | 2026-10-11 | White "Z" app mark on dark rounded square. Sanitized: removed generator comment + XML prolog only; geometry untouched. |
| Fallback (unknown ids) | starkicon.png (existing STARK brand asset) | in-repo `src/public/starkicon.png` | STARK | pre-existing | Neutral brand emblem, not a provider identity. |

## Verification notes

- STARK catalog provider labels were checked against research: meta→Meta ✓,
  zai→Z.AI/Zhipu ✓, deepseek→DeepSeek ✓, openai→OpenAI ✓, google→Google ✓,
  anthropic→Anthropic ✓, minimax→MiniMax ✓, moonshot→Moonshot AI ✓,
  xiaomi→Xiaomi ✓, nvidia→NVIDIA ✓, longcat→Meituan LongCat ✓. No catalog
  metadata changes were needed.
- Rejected third-party sources: Pinterest, logo aggregators, random repos, Fandom, image-search
  thumbnails. Wikimedia Commons copies were not used (user-uploaded repository).
- Deleted generated artwork: the previous 16 hand-authored SVGs
  (muse-spark-13/12, glm, deepseek-v41/v4, gpt-luna, gemini, claude, minimax,
  kimi, mimo-pro/flash, nemotron, mistral, longcat, fallback) were removed and
  are referenced nowhere.
