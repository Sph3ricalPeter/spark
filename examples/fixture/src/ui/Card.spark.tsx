import { Button } from "./Button";
import { Card } from "./Card";

export const ExportDialog = () => (
  <Card title="Export mixdown">
    <div>WAV · 48 kHz · 24-bit</div>
    <div className="actions">
      <Button variant="ghost">Cancel</Button>
      <Button variant="primary">Export</Button>
    </div>
  </Card>
);
export const TitleOnly = () => <Card title="Empty project">{null}</Card>;
