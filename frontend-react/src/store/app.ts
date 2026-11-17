import { create } from "zustand";

type AppState = {
  activeView: "library" | "downloads" | "trash" | "settings";
  setActiveView: (view: AppState["activeView"]) => void;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
};

export const useAppStore = create<AppState>((set) => ({
  activeView: "library",
  setActiveView: (activeView) => set({ activeView }),
  sidebarCollapsed: false,
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
}));
