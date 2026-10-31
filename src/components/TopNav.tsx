import React from 'react';
import { Plus } from 'lucide-react';
import type { NavTab } from '../types/studio';

interface TopNavProps {
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  onNewSketch: () => void;
}

const NAV_ITEMS: Array<{ id: NavTab; label: string }> = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'studio', label: 'Studio' },
  { id: 'history', label: 'History' },
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'docs', label: 'Documentation' },
];

export const TopNav: React.FC<TopNavProps> = ({ activeTab, onSelectTab, onNewSketch }) => {
  return (
    <header className="sticky top-0 z-30 bg-white border-b border-slate-200">
      <div className="max-w-[1440px] mx-auto flex items-center justify-between gap-8 px-6 py-3.5">
        {/* Zone 1: Single text element wordmark */}
        <button
          type="button"
          onClick={() => onSelectTab('dashboard')}
          className="text-lg font-display font-bold tracking-tight text-slate-900 hover:text-blue-600 transition-colors whitespace-nowrap shrink-0 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          Sketch2Shape
        </button>

        {/* Zone 2: 5 concise single-line text navigation links */}
        <nav aria-label="Primary studio navigation" className="hidden md:flex items-center gap-7 text-sm font-medium">
          {NAV_ITEMS.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${
                  isActive
                    ? 'text-slate-900 border-blue-600 font-semibold'
                    : 'text-slate-600 border-transparent hover:text-slate-900 hover:border-slate-300'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={onNewSketch}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          >
            <Plus className="w-3.5 h-3.5" aria-hidden="true" />
            <span>New Sketch</span>
          </button>
        </div>
      </div>

      {/* Compact mobile navigation row */}
      <nav
        aria-label="Mobile studio navigation"
        className="flex md:hidden items-center gap-5 overflow-x-auto px-6 py-2 border-t border-slate-100 text-xs font-medium bg-slate-50"
      >
        {NAV_ITEMS.map((item) => {
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectTab(item.id)}
              className={`py-1 whitespace-nowrap shrink-0 border-b-2 transition-colors ${
                isActive
                  ? 'text-blue-600 border-blue-600 font-semibold'
                  : 'text-slate-600 border-transparent hover:text-slate-900'
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </nav>
    </header>
  );
};
