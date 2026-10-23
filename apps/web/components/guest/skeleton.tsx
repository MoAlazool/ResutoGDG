// The menu skeleton shared by the branded loading shell and the guest pages' menu-loading state (VP-10, PERF-01).
// Kept apart from GuestLoading so the ordering pages only ship these shapes, not the whole loading shell.
import './consumer.css';

/**
 * The menu's shapes at their final sizes (assistant card, section title, dish cards): the loading shell's body, and
 * what a guest page shows in place of the menu while it loads in the browser because the server read was slow or
 * failed (PERF-01: the pages render their heading and menu in the HTML, without a loading route boundary).
 */
export function MenuSkeleton() {
  return (
    <div className="gx-menu-skeleton" aria-hidden>
      <span className="gx-sk" style={{ height: 96, borderRadius: 16, marginBlockEnd: 32 }} />
      <span className="gx-sk" style={{ maxWidth: 430, height: 50, marginBlockEnd: 22 }} />
      <div className="gx-grid">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="gx-dish">
            <span className="gx-sk gx-photo" style={{ borderRadius: 0 }} />
            <div className="gx-dish-body">
              <span className="gx-sk" style={{ width: '40%', height: 10 }} />
              <span className="gx-sk" style={{ width: '75%', height: 18, margin: '12px 0' }} />
              <span className="gx-sk" style={{ width: '90%', height: 12 }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
