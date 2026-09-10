export const REFRESH_INTERVAL_CHOICES = Object.freeze([
    Object.freeze({value: 600, label: '10 minutes'}),
    Object.freeze({value: 900, label: '15 minutes'}),
    Object.freeze({value: 1800, label: '30 minutes'}),
    Object.freeze({value: 3600, label: '60 minutes'}),
]);

export const PANEL_POSITION_CHOICES = Object.freeze([
    Object.freeze({value: 'right', label: 'Right'}),
    Object.freeze({value: 'center', label: 'Center — Beside Clock'}),
]);

export function findChoiceIndex(choices, value) {
    return choices.findIndex(choice => choice.value === value);
}

export function getChoiceValue(choices, index) {
    if (!Number.isInteger(index) || index < 0 || index >= choices.length)
        throw new RangeError('Preference choice index is out of range');
    return choices[index].value;
}
