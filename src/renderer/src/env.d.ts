/// <reference types="vite/client" />

import type { CanvasApi } from "../../preload/index";

declare global {
  interface Window {
    canvasApi: CanvasApi;
    aiCanvasDiagnostics?: {
      snapshot: () => {
        projectRoot: string;
        visibleItems: number;
        logicalProductionNodes: number;
        productionNodeIds: string[];
        duplicatePositionPairs: string[][];
        overlapPairs: string[][];
        viewport: { x: number; y: number; zoom: number };
      };
      focusNode: (nodeId: string, zoom?: number) => Promise<boolean>;
      setZoom: (zoom: number) => Promise<boolean>;
    };
  }
}

export {};
