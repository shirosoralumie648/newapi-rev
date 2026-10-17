import { useReactFlow } from '@xyflow/react'
import { useState, type DragEvent, type ReactNode } from 'react'

import { cn } from '@/lib/utils'

interface CanvasDropZoneProps {
  disabled?: boolean
  /** Receives the dropped files with the canvas coordinates of the drop. */
  onDropFiles: (files: File[], position: { x: number; y: number }) => void
  children: ReactNode
}

/**
 * The pane wrapper that accepts files dropped from the operating system. It
 * must live inside the ReactFlow provider to translate the screen coordinates
 * of the drop into canvas coordinates; a node drag of the editor itself is not
 * a file drop and passes through untouched.
 */
export function CanvasDropZone(props: CanvasDropZoneProps) {
  const reactFlow = useReactFlow()
  const [dragging, setDragging] = useState(false)

  const carriesFiles = (event: DragEvent<HTMLElement>): boolean =>
    event.dataTransfer.types.includes('Files')

  return (
    <div
      className={cn(
        'relative min-h-0 min-w-0 flex-1',
        dragging && 'ring-ring ring-2 ring-inset'
      )}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
          return
        }
        setDragging(false)
      }}
      onDragOver={(event) => {
        if (props.disabled || !carriesFiles(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setDragging(true)
      }}
      onDrop={(event) => {
        if (props.disabled || !carriesFiles(event)) return
        event.preventDefault()
        setDragging(false)
        const files = [...event.dataTransfer.files]
        if (files.length === 0) return
        props.onDropFiles(
          files,
          reactFlow.screenToFlowPosition({
            x: event.clientX,
            y: event.clientY,
          })
        )
      }}
    >
      {props.children}
    </div>
  )
}
