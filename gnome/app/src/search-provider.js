// GNOME Shell's overview search, answered by the app on the session bus
// (org.gnome.Shell.SearchProvider2 at /org/balaur/Balaur/SearchProvider;
// data/org.balaur.Balaur.search-provider.ini tells the Shell where). The Shell
// starts the app for it through D-Bus activation (data/org.balaur.Balaur.service,
// `--gapplication-service`): no window opens until a result is chosen, and an
// app started that way quits a little after the last search.
//
// What it finds is search.js's; here it is only packed for D-Bus.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {resultIds, searchItems} from './search.js';

export const SEARCH_PROVIDER_PATH = '/org/balaur/Balaur/SearchProvider';

const IFACE_XML = `
<node>
  <interface name="org.gnome.Shell.SearchProvider2">
    <method name="GetInitialResultSet">
      <arg type="as" name="terms" direction="in"/>
      <arg type="as" name="results" direction="out"/>
    </method>
    <method name="GetSubsearchResultSet">
      <arg type="as" name="previous_results" direction="in"/>
      <arg type="as" name="terms" direction="in"/>
      <arg type="as" name="results" direction="out"/>
    </method>
    <method name="GetResultMetas">
      <arg type="as" name="identifiers" direction="in"/>
      <arg type="aa{sv}" name="metas" direction="out"/>
    </method>
    <method name="ActivateResult">
      <arg type="s" name="identifier" direction="in"/>
      <arg type="as" name="terms" direction="in"/>
      <arg type="u" name="timestamp" direction="in"/>
    </method>
    <method name="LaunchSearch">
      <arg type="as" name="terms" direction="in"/>
      <arg type="u" name="timestamp" direction="in"/>
    </method>
  </interface>
</node>`;

export class SearchProvider {
    /** @param app the BalaurApplication: its services, activateResult() and launchSearch() */
    constructor(app) {
        this._app = app;
        this._items = new Map();
        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE_XML, this);
    }

    export(connection) {
        this._dbus.export(connection, SEARCH_PROVIDER_PATH);
    }

    unexport() {
        this._dbus.unexport();
    }

    // Each call keeps a service-mode app alive for its inactivity timeout.
    _busy(fn) {
        this._app.hold();
        try {
            return fn();
        } finally {
            this._app.release();
        }
    }

    _search(terms) {
        return this._busy(() => {
            const items = searchItems(this._app.services.list);
            this._items = new Map(items.map(i => [i.id, i]));
            return resultIds(items, terms);
        });
    }

    GetInitialResultSet(terms) {
        return this._search(terms);
    }

    // The data is small and in memory: search afresh rather than narrow.
    GetSubsearchResultSet(_previous, terms) {
        return this._search(terms);
    }

    GetResultMetas(ids) {
        return this._busy(() => ids.map(id => this._meta(id)).filter(Boolean));
    }

    _meta(id) {
        const v = s => new GLib.Variant('s', s);
        const item = this._items.get(id);
        if (!item)
            return null;
        const gicon = item.icon ?? this._appIcon(item.desktopId) ?? 'org.balaur.Balaur';
        return {id: v(id), name: v(item.name), description: v(item.description), gicon: v(gicon)};
    }

    // A service's GNOME app icon, as a GIcon string.
    _appIcon(desktopId) {
        if (!desktopId)
            return null;
        const info = this._app.services.appInfo({desktopId});
        return info?.get_icon()?.to_string() ?? null;
    }

    ActivateResult(id, terms, _timestamp) {
        this._busy(() => this._app.activateResult(id, terms));
    }

    LaunchSearch(terms, _timestamp) {
        this._busy(() => this._app.launchSearch(terms));
    }
}
