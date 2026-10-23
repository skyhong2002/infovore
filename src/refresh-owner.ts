// Production owns source refreshes and their sync-run bookkeeping. A rollout
// candidate (scripts/deploy.sh) shares the database while production still
// refreshes, so it must neither schedule refreshes nor mark production's
// in-flight runs as abandoned.
export function startRefreshOwner(
  role: string | undefined,
  repository: { abandonRunningSyncs(): number },
  schedule: () => Promise<void>,
): boolean {
  if (role === 'candidate') return false;
  // This process is the only refresh owner, so any run still marked running was
  // left behind by a previous one.
  const abandoned = repository.abandonRunningSyncs();
  if (abandoned) console.warn(`[refresh] marked ${abandoned} unfinished run(s) from a previous process as abandoned`);
  schedule().catch((error) => {
    console.error(`[refresh] cycle failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  return true;
}
