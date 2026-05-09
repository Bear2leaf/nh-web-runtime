/**
 * Status field dispatch and level-change detection.
 *
 * shim_status_update receives field index + a pointer/value.
 * This module parses the value and updates the DOM.
 */

import S from './state.js';
import { setStatusField, log } from './ui.js';
import { MAP_HEIGHT, MAP_WIDTH } from './map.js';

export const BL = {
    BL_TITLE: 0,
    BL_STR: 1, BL_DX: 2, BL_CO: 3, BL_IN: 4, BL_WI: 5, BL_CH: 6,
    BL_ALIGN: 7, BL_SCORE: 8, BL_CAP: 9, BL_GOLD: 10,
    BL_ENE: 11, BL_ENEMAX: 12, BL_XP: 13, BL_AC: 14, BL_HD: 15,
    BL_TIME: 16, BL_HUNGER: 17, BL_HP: 18, BL_HPMAX: 19,
    BL_LEVELDESC: 20, BL_EXP: 21, BL_CONDITION: 22,
    BL_WEAPON: 23, BL_ARMOR: 24, BL_TERRAIN: 25,
    BL_VERS: 26,
};

export function updateStatusUI(fldidx, rawValue, valueType, chg, percent, color) {
    const displayValue = valueType === 's' ? String(rawValue || '') : String(rawValue || 0);

    log('updateUI: fld=' + fldidx + ' val="' + displayValue + '"');

    switch (fldidx) {
        case BL.BL_TITLE:
            setStatusField('stat-role', displayValue);
            break;
        case BL.BL_STR:
            setStatusField('stat-str', displayValue);
            break;
        case BL.BL_DX:
            setStatusField('stat-dex', displayValue);
            break;
        case BL.BL_CO:
            setStatusField('stat-con', displayValue);
            break;
        case BL.BL_IN:
            setStatusField('stat-int', displayValue);
            break;
        case BL.BL_WI:
            setStatusField('stat-wis', displayValue);
            break;
        case BL.BL_CH:
            setStatusField('stat-cha', displayValue);
            break;
        case BL.BL_ALIGN:
            setStatusField('stat-align', displayValue);
            break;
        case BL.BL_SCORE:
            setStatusField('stat-score', displayValue);
            break;
        case BL.BL_CAP:
            setStatusField('stat-cap', displayValue);
            break;
        case BL.BL_GOLD:
            setStatusField('stat-gold', displayValue);
            break;
        case BL.BL_ENE:
            setStatusField('stat-energy', displayValue);
            break;
        case BL.BL_ENEMAX:
            setStatusField('stat-maxenergy', displayValue);
            break;
        case BL.BL_XP:
            setStatusField('stat-level', displayValue);
            break;
        case BL.BL_AC:
            setStatusField('stat-ac', displayValue);
            break;
        case BL.BL_HD:
            // BL_HD is "hit dice" (monster level when polymorphed), always 0 for normal player
            // Not shown in UI
            break;
        case BL.BL_TIME:
            setStatusField('stat-time', displayValue);
            break;
        case BL.BL_HUNGER:
            setStatusField('stat-hunger', displayValue);
            break;
        case BL.BL_HP:
            setStatusField('stat-hp', displayValue);
            break;
        case BL.BL_HPMAX:
            setStatusField('stat-maxhp', displayValue);
            break;
        case BL.BL_LEVELDESC: {
            const levelChanged = S.lastLevelDesc && displayValue !== S.lastLevelDesc;
            log('BL_LEVELDESC: last="' + S.lastLevelDesc + '" curr="' + displayValue + '" changed=' + levelChanged);
            if (levelChanged) {
                log('Level changed: clearing map');
                for (let y = 0; y < MAP_HEIGHT; y++) {
                    for (let x = 0; x < MAP_WIDTH; x++) {
                        S.mapRows[y][x] = ' ';
                        S.mapColors[y][x] = 0;
                    }
                }
            }
            S.lastLevelDesc = displayValue;
            setStatusField('stat-dlvl', displayValue);
            break;
        }
        case BL.BL_EXP:
            setStatusField('stat-level', displayValue);
            break;
        case BL.BL_CONDITION:
            setStatusField('stat-condition', displayValue);
            break;
        default:
            break;
    }
}
