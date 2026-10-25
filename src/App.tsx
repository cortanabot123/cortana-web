import { Chat } from "@/components/chat"
import { TooltipProvider } from "@/components/ui/tooltip"

/**
 * Mobile-first shell: full screen on a phone, and a phone-sized frame when
 * opened on a desktop browser.
 */
export default function App() {
  return (
    <TooltipProvider delay={300}>
      <div data-build={__CORTANA_BUILD_ID__} className="flex h-dvh w-full overflow-hidden bg-background">
        <div data-chat-panel className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-background">
          <Chat />
        </div>
      </div>
    </TooltipProvider>
  )
}
