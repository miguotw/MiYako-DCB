'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

function dateKeyAt(epoch, timezoneOffset) {
    const shifted = new Date(epoch + timezoneOffset * 60 * 60 * 1000);
    const year = shifted.getFullYear();
    const month = String(shifted.getMonth() + 1).padStart(2, '0');
    const day = String(shifted.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function scheduledEpoch(date, time, timezoneOffset) {
    const [year, month, day] = date.split('-').map(Number);
    const [hour, minute] = time.split(':').map(Number);
    const localEpoch = new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
    return localEpoch - timezoneOffset * 60 * 60 * 1000;
}

function nextDateKey(date) {
    const [year, month, day] = date.split('-').map(Number);
    const localNoon = new Date(year, month - 1, day, 12, 0, 0, 0).getTime();
    return dateKeyAt(localNoon + DAY_MS, 0);
}

function nextCheckInEpoch(epoch, time, timezoneOffset) {
    const date = dateKeyAt(epoch, timezoneOffset);
    const todayAt = scheduledEpoch(date, time, timezoneOffset);
    return epoch < todayAt ? todayAt : scheduledEpoch(nextDateKey(date), time, timezoneOffset);
}

module.exports = { dateKeyAt, nextCheckInEpoch, nextDateKey, scheduledEpoch };
