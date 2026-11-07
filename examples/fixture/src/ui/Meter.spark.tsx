import { Meter } from "./Meter";

export const Quiet = () => <Meter level={0.15} />;
export const Half = () => <Meter level={0.5} />;
export const Clipping = () => <Meter level={1} />;
