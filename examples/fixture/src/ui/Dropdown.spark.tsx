import { Dropdown } from "./Dropdown";

const OUTPUTS = ["Speakers", "Headphones", "Audio interface 1–2", "Audio interface 3–4", "HDMI", "Bluetooth", "Loopback", "Record to file"];

export const Closed = () => <Dropdown value="Speakers" options={OUTPUTS} />;
export const Open = () => <Dropdown value="Headphones" options={OUTPUTS} open />;
