import { useEffect } from 'react';
import { AppShell } from './components/layout/AppShell.tsx';
import { useUIStore } from './store/ui-store.ts';
import { useDungeonStore } from './store/dungeon-store.ts';

export function App() {
  const darkMode = useUIStore((s) => s.darkMode);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light');
  }, [darkMode]);

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

  return <AppShell />;
}
