import { useNexus } from "../state/store";
import Workstation from "./Workstation";
import BrainCore from "./BrainCore";

/**
 * 3×3 grid: workstations wrap around the central brain core.
 * Zones 0..5 map clockwise around the centre cell.
 */
export default function WorkstationGrid() {
  const workers = useNexus((s) => s.workers);
  const byZone = [...workers].sort((a, b) => a.zone - b.zone);

  return (
    <main className="grid-wrap">
      <div className="ws-grid">
        <div className="cell">{byZone[0] && <Workstation worker={byZone[0]} />}</div>
        <div className="cell">{byZone[1] && <Workstation worker={byZone[1]} />}</div>
        <div className="cell">{byZone[2] && <Workstation worker={byZone[2]} />}</div>
        <div className="cell">{byZone[3] && <Workstation worker={byZone[3]} />}</div>
        <div className="cell center"><BrainCore /></div>
        <div className="cell">{byZone[4] && <Workstation worker={byZone[4]} />}</div>
        <div className="cell wide-bottom">{byZone[5] && <Workstation worker={byZone[5]} />}</div>
      </div>
    </main>
  );
}
