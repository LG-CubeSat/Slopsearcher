export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  invoke: (input: unknown) => Promise<unknown>;
}
export interface RunRequest {
  threadId?: string | null;
  prompt: string;
  instructions: string;
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
