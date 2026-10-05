export interface ReviewFile {
  path: string;
  name: string;
  status: string;
  additions: number;
  deletions: number;
  binary?: boolean;
  omitted?: boolean;
}

export interface GitStatusResult {
  is_git: boolean;
  branch: string | null;
  dirty: boolean;
  untracked_files: string[];
  modified_files: string[];
  repository_root?: string;
  files?: { path: string; status: string; original_path?: string }[];
}

export interface DiffNumstatResult {
  files: Record<string, { additions: number; deletions: number; binary?: boolean; omitted?: boolean }>;
}
