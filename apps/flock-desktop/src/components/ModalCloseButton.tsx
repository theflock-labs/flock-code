import IconButton from "./IconButton";
import { XIcon } from "./friendIcons";

interface Props {
  onClose: () => void;
}

/** Top-right X to close a dialog, alongside Esc as a second, more
 * discoverable way to do the same thing. */
export default function ModalCloseButton({ onClose }: Props) {
  return (
    <IconButton className="modal-close-x" icon={<XIcon size={13} />} label="Close dialog" onClick={onClose} />
  );
}
