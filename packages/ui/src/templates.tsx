// Page templates (plan §4 "Layout"). They own the page's regions and spacing only; content, data and state stay in
// the page. Breakpoints: phone < 700 px, tablet 700-1100 px, desktop > 1100 px. Inspectors sit at the reading end.
// One module per template (templates/*.tsx), so a route ships only the templates it renders; this file re-exports them.
export type { PageHeaderProps } from './templates/header';
export { ListPage } from './templates/list';
export { DetailPage } from './templates/detail';
export { WorkspacePage } from './templates/workspace';
export { BoardPage, type BoardLane } from './templates/board';
export { SettingsPage, type SettingsSection } from './templates/settings';
