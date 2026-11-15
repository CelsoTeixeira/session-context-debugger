import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface AccessibleTab {
  id: string;
  label: string;
  content: ReactNode;
}

export function AccessibleTabs({ id, label, tabs, active, visited, onActivate, className = '' }: {
  id: string;
  label: string;
  tabs: AccessibleTab[];
  active: string;
  visited: ReadonlySet<string>;
  onActivate: (id: string) => void;
  className?: string;
}) {
  const generatedId = useId().replace(/:/g, '');
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const [focused, setFocused] = useState<string>();
  const tabId = (tab: string) => generatedId + '-' + id + '-tab-' + tab;
  const panelId = (tab: string) => generatedId + '-' + id + '-panel-' + tab;

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number | undefined;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    buttons.current[next]?.focus();
  }

  return <div className={'tab-workspace ' + className}>
    <div className="tab-workspace-list" role="tablist" aria-label={label} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) setFocused(undefined);
    }}>
      {tabs.map((tab, index) => <button
        key={tab.id}
        ref={element => { buttons.current[index] = element; }}
        id={tabId(tab.id)}
        type="button"
        role="tab"
        aria-selected={active === tab.id}
        aria-controls={panelId(tab.id)}
        tabIndex={(focused ?? active) === tab.id ? 0 : -1}
        onFocus={() => setFocused(tab.id)}
        onClick={() => onActivate(tab.id)}
        onKeyDown={event => handleKeyDown(event, index)}
      >{tab.label}</button>)}
    </div>
    {tabs.map(tab => <div
      key={tab.id}
      id={panelId(tab.id)}
      className="tab-workspace-panel"
      role="tabpanel"
      aria-labelledby={tabId(tab.id)}
      hidden={active !== tab.id}
    >{visited.has(tab.id) ? tab.content : null}</div>)}
  </div>;
}
