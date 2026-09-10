import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {
    ConverterAsset,
    ConverterAssetInfo,
    ConverterAssets,
    convertAll,
    parseAmount,
} from '../core/converter.js';
import {InvalidAmountError, MissingQuoteError} from '../core/errors.js';
import {formatNumber} from './format.js';

const SOURCE_LABELS = Object.freeze({
    [ConverterAsset.TRY]: 'TRY',
    [ConverterAsset.USD]: 'USD',
    [ConverterAsset.EUR]: 'EUR',
    [ConverterAsset.GOLD_GRAM]: 'Gold g',
});

const RESULT_LABELS = Object.freeze({
    [ConverterAsset.TRY]: 'TRY',
    [ConverterAsset.USD]: 'USD',
    [ConverterAsset.EUR]: 'EUR',
    [ConverterAsset.GOLD_GRAM]: 'Gold (g)',
});

export class ConverterView {
    constructor(_) {
        this._ = _;
        this._sourceAsset = ConverterAsset.TRY;
        this._quotes = {};
        this._signalConnections = [];

        this.actor = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'exchangebar-converter',
        });

        const title = new St.Label({
            text: _('Converter'),
            x_align: Clutter.ActorAlign.START,
            style_class: 'exchangebar-converter-title',
        });
        this.actor.add_child(title);

        const sourceBox = new St.BoxLayout({
            x_expand: true,
            style_class: 'exchangebar-converter-sources',
        });
        this._sourceButtons = new Map();
        for (const asset of ConverterAssets) {
            const button = new St.Button({
                label: _(SOURCE_LABELS[asset]),
                toggle_mode: true,
                can_focus: true,
                x_expand: true,
                style_class: 'exchangebar-converter-source button',
            });
            button.checked = asset === this._sourceAsset;
            const signalId = button.connect('clicked', () => {
                this._setSource(asset);
            });
            this._signalConnections.push([button, signalId]);
            this._sourceButtons.set(asset, button);
            sourceBox.add_child(button);
        }
        this.actor.add_child(sourceBox);

        const inputBox = new St.BoxLayout({
            x_expand: true,
            style_class: 'exchangebar-converter-input-row',
        });
        inputBox.add_child(new St.Label({
            text: _('Amount'),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._entry = new St.Entry({
            text: '1000',
            hint_text: _('Amount'),
            can_focus: true,
            x_align: Clutter.ActorAlign.END,
            style_class: 'exchangebar-converter-input',
        });
        const textSignalId = this._entry.clutter_text.connect(
            'text-changed', () => this._renderResults());
        this._signalConnections.push([this._entry.clutter_text, textSignalId]);
        inputBox.add_child(this._entry);
        this.actor.add_child(inputBox);

        this._resultRows = new Map();
        for (const asset of ConverterAssets) {
            const row = new St.BoxLayout({
                x_expand: true,
                style_class: 'exchangebar-converter-result',
            });
            const label = new St.Label({
                text: _(RESULT_LABELS[asset]),
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const value = new St.Label({
                text: '—',
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'exchangebar-converter-result-value',
            });
            row.add_child(label);
            row.add_child(value);
            this.actor.add_child(row);
            this._resultRows.set(asset, {row, value});
        }

        this._message = new St.Label({
            text: '',
            x_align: Clutter.ActorAlign.START,
            style_class: 'exchangebar-converter-message',
        });
        this.actor.add_child(this._message);
        this._renderResults();
    }

    render(quotes) {
        this._quotes = quotes ?? {};
        this._renderResults();
    }

    _setSource(asset) {
        this._sourceAsset = asset;
        for (const [id, button] of this._sourceButtons)
            button.checked = id === asset;
        this._renderResults();
    }

    _renderResults() {
        if (!this._entry)
            return;

        for (const [asset, result] of this._resultRows)
            result.row.visible = asset !== this._sourceAsset;

        try {
            const amount = parseAmount(this._entry.get_text());
            const conversions = convertAll(
                amount, this._sourceAsset, this._quotes);
            for (const conversion of conversions) {
                const info = ConverterAssetInfo[conversion.asset];
                this._resultRows.get(conversion.asset).value.text =
                    formatNumber(conversion.value, info.precision);
            }
            this._message.text = '';
            this._message.visible = false;
        } catch (error) {
            for (const result of this._resultRows.values())
                result.value.text = '—';
            if (error instanceof InvalidAmountError)
                this._message.text = this._('Enter a valid amount');
            else if (error instanceof MissingQuoteError)
                this._message.text = this._('Rates are unavailable');
            else
                this._message.text = this._('Conversion is unavailable');
            this._message.visible = true;
        }
    }

    destroy() {
        for (const [object, id] of this._signalConnections)
            object.disconnect(id);
        this._signalConnections = [];
        this._sourceButtons.clear();
        this._resultRows.clear();
        this._quotes = null;
        this._entry = null;
        this._message = null;
        this.actor = null;
        this._ = null;
    }
}
