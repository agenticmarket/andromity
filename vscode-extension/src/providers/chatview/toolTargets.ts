export function getToolTargetSummary(name: string, raw: unknown): string {
  let args: Record<string, unknown>;
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
    args = value as Record<string, unknown>;
  } catch { return ''; }
  const paths = ['path', 'target_path', 'target_file', 'file_path', 'TargetFile'];
  const commands = ['command', 'cmd', 'CommandLine'];
  const keys = /^(list_dir|read_file|view_file|write_file|edit_file|edit_file_multi|find_files|grep_search)$/.test(name)
    ? paths : /^(shell_exec|shell_bg|run_command|bash|exec|cmd)$/.test(name) ? commands : [];
  for (const key of keys) {
    if (typeof args[key] === 'string' && (args[key] as string).trim()) {
      return (args[key] as string).replace(/[\r\n\t]+/g, ' ').trim();
    }
  }
  return '';
}

export function getToolTargetsScript(): string {
  return 'const getToolTargetSummary = ' + getToolTargetSummary.toString() + ';';
}
