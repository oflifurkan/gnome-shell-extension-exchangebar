export const PanelPosition = Object.freeze({
    RIGHT: 'right',
    CENTER: 'center',
});

const RIGHT_PLACEMENT = Object.freeze({box: 'right', position: 0});
const CENTER_PLACEMENT = Object.freeze({box: 'center', position: -1});

export function getPanelPlacement(position) {
    if (position === PanelPosition.CENTER)
        return CENTER_PLACEMENT;
    return RIGHT_PLACEMENT;
}
