export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  invoke: (input: unknown) => Promise<unknown>;
}
/** Only application-created instances may add image content to tool output. */
export class VisualToolResult {
  constructor(
    readonly data: unknown,
    readonly imageUrl: string,
  ) {}
}
export interface RunRequest {
  threadId?: string | null;
  prompt: string;
  instructions: string;
  images?: { dataUrl: string; description: string }[];
  tools: ToolDefinition[];
  outputSchema?: Record<string, unknown>;
  webSearch?: boolean;
  signal?: AbortSignal;
  onThread?: (id: string) => void;
  onProgress?: (text: string) => void;
}
export interface ResearchRunner {
  isReady?: () => Promise<boolean>;
  run(request: RunRequest): Promise<{ threadId: string; text: string }>;
}
