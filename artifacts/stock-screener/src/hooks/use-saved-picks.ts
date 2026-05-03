import { useState, useCallback, useEffect } from "react";
import type { SectorWithStocks } from "@workspace/api-client-react";
import { format } from "date-fns";

export interface SavedPickRecord {
  date: string;
  fetchedAt: string;
  sectors: SectorWithStocks[];
}

const STORAGE_KEY = "stock-screener-picks";

export function useSavedPicks() {
  const [savedPicks, setSavedPicks] = useState<SavedPickRecord[]>([]);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        setSavedPicks(JSON.parse(stored));
      } catch (e) {
        console.error("Failed to parse saved picks", e);
      }
    }
  }, []);

  const saveTodayPicks = useCallback((fetchedAt: string, sectors: SectorWithStocks[]) => {
    const dateStr = format(new Date(), "yyyy-MM-dd");
    
    setSavedPicks((prev) => {
      const filtered = prev.filter((p) => p.date !== dateStr);
      const newRecord = { date: dateStr, fetchedAt, sectors };
      const updated = [newRecord, ...filtered].sort((a, b) => b.date.localeCompare(a.date));
      
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  const getTodayPicks = useCallback(() => {
    const dateStr = format(new Date(), "yyyy-MM-dd");
    return savedPicks.find((p) => p.date === dateStr);
  }, [savedPicks]);

  return { savedPicks, saveTodayPicks, getTodayPicks };
}
