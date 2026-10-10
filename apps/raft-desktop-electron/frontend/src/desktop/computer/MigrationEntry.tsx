// "Run the Computer independently…" entry under the embedded "This Computer" card. The dialog it opens is
// MigrationDialog (mounted once at the app root). Hidden unless this build carries a Computer to migrate with.
import { deriveMigrationView } from "./migrationLogic";
import { useMigration } from "./useMigration";

export default function MigrationEntry() {
  const { state, begin } = useMigration();
  const view = deriveMigrationView(state);
  if (!view.available) return null;
  return (
    <button
      type="button"
      className="mb-1.5 w-full border-2 border-dashed border-black/30 px-2.5 py-1.5 text-left text-[11px] font-medium text-black/60 hover:border-black hover:text-black"
      data-testid="migrate-computer-entry"
      onClick={() => void begin()}
    >
      Run the Computer independently…
    </button>
  );
}
