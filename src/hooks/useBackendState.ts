import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Hook that syncs state with the Python backend.
 * On mount, loads state from GET /api/state.
 * On every state change, debounced saves via PUT /api/state.
 */
export function useBackendState<T>(defaultValue: T): [T, (value: T | ((prev: T) => T)) => void, boolean, string | null] {
  const [state, setStateInternal] = useState<T>(defaultValue);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const saveTimeoutRef = useRef<number | null>(null);
  const initialized = useRef(false);
  const latestStateRef = useRef<T>(defaultValue);

  // Load state from backend on mount
  useEffect(() => {
    let cancelled = false;

    const loadState = async () => {
      try {
        const res = await fetch('/api/state');
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }
        const data = await res.json();
        if (!cancelled) {
          // Merge with defaults to ensure all fields exist
          const merged = { ...defaultValue, ...data };
          setStateInternal(merged);
          latestStateRef.current = merged;
          initialized.current = true;
          setError(null);
        }
      } catch (err: any) {
        console.error('Failed to load state from backend:', err);
        if (!cancelled) {
          // Fall back to localStorage if backend is not available
          try {
            const localData = window.localStorage.getItem('llm-manager-state');
            if (localData) {
              const parsed = JSON.parse(localData);
              const merged = { ...defaultValue, ...parsed };
              setStateInternal(merged);
              latestStateRef.current = merged;
              setError('Backend unavailable, using local data. Start server.py for persistence.');
            } else {
              setError('Backend unavailable. Start server.py for persistence.');
            }
          } catch {
            setError('Backend unavailable. Start server.py for persistence.');
          }
          initialized.current = true;
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    loadState();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Save to backend (debounced)
  const saveToBackend = useCallback((newState: T) => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    saveTimeoutRef.current = window.setTimeout(async () => {
      try {
        const res = await fetch('/api/state', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newState),
        });
        if (!res.ok) {
          throw new Error(`Save failed: HTTP ${res.status}`);
        }
        setError(null);
        // Also save to localStorage as backup
        try {
          window.localStorage.setItem('llm-manager-state', JSON.stringify(newState));
        } catch {
          // localStorage might be full, ignore
        }
      } catch (err: any) {
        console.error('Failed to save state to backend:', err);
        // Save to localStorage as fallback
        try {
          window.localStorage.setItem('llm-manager-state', JSON.stringify(newState));
        } catch {
          // ignore
        }
        setError('Failed to save to backend. Data saved locally.');
      }
    }, 300); // 300ms debounce
  }, []);

  // Wrapped setState that also triggers backend save
  const setState = useCallback((value: T | ((prev: T) => T)) => {
    setStateInternal(prev => {
      const newState = value instanceof Function ? value(prev) : value;
      latestStateRef.current = newState;
      if (initialized.current) {
        saveToBackend(newState);
      }
      return newState;
    });
  }, [saveToBackend]);

  return [state, setState, loading, error];
}
