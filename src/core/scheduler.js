import GLib from 'gi://GLib';

export class GlibScheduler {
    scheduleSeconds(delay, callback) {
        return GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            delay,
            () => {
                callback();
                return GLib.SOURCE_REMOVE;
            });
    }

    cancel(sourceId) {
        if (sourceId > 0)
            GLib.source_remove(sourceId);
    }
}
