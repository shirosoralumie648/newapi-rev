/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import type { ReactNode } from 'react'

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { useIsMobile } from '@/hooks/use-mobile'

interface WorkspaceInspectorProps {
  /** Desktop panel visibility. The mobile Sheet uses the same flag. */
  open: boolean
  onClose: () => void
  title: string
  description?: string
  main: ReactNode
  children: ReactNode
  mainDefaultSize?: string
  mainMinSize?: string
  panelDefaultSize?: string
  panelMinSize?: string
  mobileClassName?: string
}

/**
 * Shared right-side Inspector shell used by the Playground chat workspace and
 * the canvas editor. Desktop shows the workspace and the Inspector side by side
 * in a resizable group; mobile presents the Inspector in a right Sheet so the
 * Base UI focus trap and focus restore apply. Closing is delegated to
 * `onClose`, which keeps the caller's unsaved-draft guard intact.
 */
export function WorkspaceInspector(props: WorkspaceInspectorProps) {
  const isMobile = useIsMobile()

  if (isMobile) {
    return (
      <>
        <div className='min-h-0 flex-1'>{props.main}</div>
        <Sheet
          open={props.open}
          onOpenChange={(open) => {
            if (!open) props.onClose()
          }}
        >
          <SheetContent
            className={props.mobileClassName ?? 'w-full gap-0 p-0 sm:max-w-3xl'}
            side='right'
          >
            <SheetHeader className='sr-only'>
              <SheetTitle>{props.title}</SheetTitle>
              {props.description ? (
                <SheetDescription>{props.description}</SheetDescription>
              ) : null}
            </SheetHeader>
            {props.children}
          </SheetContent>
        </Sheet>
      </>
    )
  }

  if (!props.open) {
    return <div className='min-h-0 flex-1'>{props.main}</div>
  }

  return (
    <ResizablePanelGroup
      className='min-h-0 flex-1'
      orientation='horizontal'
    >
      <ResizablePanel
        defaultSize={props.mainDefaultSize ?? '62'}
        minSize={props.mainMinSize ?? '35'}
      >
        {props.main}
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel
        defaultSize={props.panelDefaultSize ?? '38'}
        minSize={props.panelMinSize ?? '28'}
      >
        {props.children}
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
