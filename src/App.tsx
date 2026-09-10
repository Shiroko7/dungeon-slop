import { useEffect, useState } from 'react';
import { AppShell } from './components/layout/AppShell.tsx';
import { useUIStore } from './store/ui-store.ts';
import { useDungeonStore } from './store/dungeon-store.ts';
import { runLegacyImport } from './migrate/legacy-import.ts';
import { navigate, paths } from './router/router.ts';
import { LoadingSpinner } from './components/shared/LoadingSpinner.tsx';

export function App() {
  const darkMode = useUIStore((s) => s.darkMode);
  const [migrating, setMigrating] = useState(true);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light');
  }, [darkMode]);

  // The move out of localStorage runs once, before anything renders — otherwise
  // the picker would flash an empty state and then fill in behind the user.
  useEffect(() => {
    let cancelled = false;
    void runLegacyImport()
      .then((outcome) => {
        if (cancelled) return;
        if (outcome !== null && outcome.campaignId !== null && window.location.pathname === '/') {
          navigate(
            outcome.dungeonId === null
              ? paths.campaign(outcome.campaignId)
              : paths.dungeon(outcome.campaignId, outcome.dungeonId),
            { replace: true },
          );
        }
      })
      .finally(() => {
        if (!cancelled) setMigrating(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;

      if (e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        useDungeonStore.getState().undoEdit();
      } else if (e.key === 'y' || (e.key === 'z' && e.shiftKey)) {
        e.preventDefault();
        useDungeonStore.getState().redoEdit();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  if (migrating) {
    return (
      <div className="boot">
        <LoadingSpinner />
      </div>
    );
  }

  return <AppShell />;
}
