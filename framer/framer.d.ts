/**
 * Local editor types for the Framer-hosted copy of AdminPortal.
 * Framer provides these APIs when the component runs on its canvas.
 */
declare module "framer" {
    import type { ComponentType } from "react"

    export const ControlType: {
        Boolean: unknown
        Color: unknown
        Enum: unknown
        String: unknown
    }

    export function addPropertyControls<Props>(
        component: ComponentType<Props>,
        controls: Record<string, unknown>
    ): void

    export function useIsStaticRenderer(): boolean
}
