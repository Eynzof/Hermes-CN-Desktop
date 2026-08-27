// Shared jsdom stubs for rendering Radix-based interactive components in Vitest.
// Radix (via @floating-ui) needs ResizeObserver / matchMedia / pointer events that
// jsdom does not provide; these no-op stubs keep portal content renderable so the
// tests can drive the real button workflows.
export function stubRadixGlobals(): void {
  if (typeof window !== "undefined") {
    if (!("ResizeObserver" in window)) {
      class ResizeObserverStub {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
      // @ts-expect-error - adding a global polyfill
      window.ResizeObserver = ResizeObserverStub;
    }
    if (!("matchMedia" in window)) {
      // @ts-expect-error - adding a global polyfill
      window.matchMedia = (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      });
    }
    if (!("scrollTo" in window)) {
      // @ts-expect-error - adding a global polyfill
      window.scrollTo = () => {};
    }
  }
  // PointerEvent is used by Radix for press detection.
  if (typeof globalThis !== "undefined" && !("PointerEvent" in globalThis)) {
    class PointerEventStub extends Event {
      constructor(type: string, params: Partial<PointerEvent> = {}) {
        super(type, params);
        this.button = params.button ?? 0;
      }
      button = 0;
    }
    // @ts-expect-error - adding a global polyfill
    globalThis.PointerEvent = PointerEventStub;
  }
}
