import type { ReactElement } from 'react'
import { StarkIcon } from '../../../../components/icons/StarkIcon'

interface AddModelCardProps {
  readonly onOpen: () => void
}

/**
 * Grid-native Add entry: same dimensions and visual language as a
 * model card, centered plus + label. A real button (keyboard
 * accessible), last in the grid.
 */
export function AddModelCard({ onOpen }: AddModelCardProps): ReactElement {
  return (
    <button className="models-card models-card--add" type="button" onClick={onOpen} aria-label="Add model">
      <span className="models-card__icon" aria-hidden="true">
        <StarkIcon name="plus" size={22} />
      </span>
      <span className="models-card__name">Add model</span>
    </button>
  )
}
