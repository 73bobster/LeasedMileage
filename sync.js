// sync.js — data layer for LeasedMileage.
// Talks to the SAME Supabase project as MotoringMonitor: same tables,
// same RLS policies, same households. This file only ever reads/writes
// a subset of that schema (households, household_members, vehicles,
// readings) and makes NO schema changes of its own.

// ── Fill these in with the same values MotoringMonitor's index.html
// uses (Supabase dashboard → Project Settings → Data API / API Keys) ──
const QUEUE_KEY = 'leasedmileage_offline_queue';

let _supabase = null;
function getClient() {
  if (_supabase) return _supabase;
  _supabase = window.NeonCompat.client;
  return _supabase;
}

const Sync = {

  // ---------- Auth ----------

  async signUp(email, password) {
    const { data, error } = await getClient().auth.signUp({ email, password });
    if (error) throw error;
    // Make sure we're signed in afterwards (Neon may not do it automatically).
    const s = await getClient().auth.getSession();
    if (!s.data.session) {
      const r = await getClient().auth.signInWithPassword({ email, password });
      if (r.error) throw r.error;
    }
    return data;
  },

  async signIn(email, password) {
    const { data, error } = await getClient().auth.signInWithPassword({ email, password });
    if (error) throw error;
    // Neon only announces sign-in to other tabs, so tell this tab ourselves.
    if (this._cb) this._cb(data && data.session ? data.session : null);
    return data;
  },

  async signOut() {
    await getClient().auth.signOut();
    if (this._cb) this._cb(null);
  },

  async getSession() {
    const { data } = await getClient().auth.getSession();
    return data.session;
  },

  onAuthChange(callback) {
    this._cb = callback;
    getClient().auth.onAuthStateChange((_event, session) => callback(session));
  },

  // ---------- Household ----------

  async getMyHouseholdId() {
    const { data: sessionData } = await getClient().auth.getSession();
    const userId = sessionData.session?.user?.id;
    if (!userId) return null;
    const { data, error } = await getClient()
      .from('household_members')
      .select('household_id')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data ? data.household_id : null;
  },

  async createHousehold() {
    const { data, error } = await getClient().rpc('create_my_household');
    if (error) throw error;
    return data;
  },

  async joinHousehold(code) {
    const { data, error } = await getClient().rpc('join_household', { code });
    if (error) throw error;
    return data;
  },

  // ---------- Vehicles ----------

  async fetchVehicles(householdId) {
    const { data, error } = await getClient()
      .from('vehicles')
      .select('*')
      .eq('household_id', householdId)
      .eq('archived', false)
      .eq('ownership_type', 'leased')
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data;
  },

  // Minimal lease-focused vehicle add. ownership_type is always 'leased'
  // for this app — never shown to, or chosen by, the user.
  async addVehicle(householdId, fields) {
    const payload = {
      household_id: householdId,
      ownership_type: 'leased',
      nickname: fields.nickname,
      make: fields.make || null,
      term_start: fields.term_start || null,
      term_end: fields.term_end || null,
      capped_miles: fields.capped_miles,
      cost_per_excess_mile: fields.cost_per_excess_mile,
      opening_mileage: fields.opening_mileage,
    };
    return this.writeWithQueue('insert', 'vehicles', payload);
  },

  async updateVehicle(vehicleId, fields) {
    const payload = {
      nickname: fields.nickname,
      make: fields.make || null,
      term_start: fields.term_start || null,
      term_end: fields.term_end || null,
      capped_miles: fields.capped_miles,
      cost_per_excess_mile: fields.cost_per_excess_mile,
      opening_mileage: fields.opening_mileage,
      updated_at: new Date().toISOString(),
    };
    return this.writeWithQueue('update', 'vehicles', payload, { id: vehicleId });
  },

  // ---------- Readings ----------

  async fetchLatestReading(vehicleId) {
    const { data, error } = await getClient()
      .from('readings')
      .select('*')
      .eq('vehicle_id', vehicleId)
      .order('date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data;
  },

  // Full reading history, oldest first — needed for the EWMA pace calc
  // that matches MotoringMonitor's forecast formula.
  async fetchReadings(vehicleId) {
    const { data, error } = await getClient()
      .from('readings')
      .select('*')
      .eq('vehicle_id', vehicleId)
      .order('date', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data;
  },

  // Rejects a reading lower than the current highest mileage on file.
  // Returns { ok: true } or { ok: false, message }.
  async addReading(householdId, vehicleId, mileage, currentMileage) {
    if (currentMileage != null && mileage < currentMileage) {
      return { ok: false, message: `Must be ${currentMileage.toLocaleString()} or higher` };
    }
    const payload = {
      household_id: householdId,
      vehicle_id: vehicleId,
      date: new Date().toISOString().slice(0, 10),
      mileage,
    };
    await this.writeWithQueue('insert', 'readings', payload);
    return { ok: true };
  },

  // ---------- Offline queue ----------
  // Failed writes (network down) get queued in localStorage and
  // retried when the browser comes back online. UI layer should call
  // flushQueue() on a 'online' event and on app start.

  async writeWithQueue(op, table, payload, match) {
    try {
      return await this._write(op, table, payload, match);
    } catch (err) {
      if (!navigator.onLine) {
        this._enqueue({ op, table, payload, match });
        return { queued: true };
      }
      throw err;
    }
  },

  async _write(op, table, payload, match) {
    if (op === 'insert') {
      const { data, error } = await getClient().from(table).insert(payload).select().maybeSingle();
      if (error) throw error;
      return data;
    }
    if (op === 'update') {
      const { data, error } = await getClient().from(table).update(payload).match(match).select().maybeSingle();
      if (error) throw error;
      return data;
    }
  },

  _enqueue(item) {
    const queue = this._readQueue();
    queue.push({ ...item, queuedAt: Date.now() });
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  },

  _readQueue() {
    try {
      return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    } catch {
      return [];
    }
  },

  queueLength() {
    return this._readQueue().length;
  },

  async flushQueue() {
    const queue = this._readQueue();
    if (!queue.length) return { flushed: 0 };
    const remaining = [];
    let flushed = 0;
    for (const item of queue) {
      try {
        await this._write(item.op, item.table, item.payload, item.match);
        flushed++;
      } catch {
        remaining.push(item);
      }
    }
    localStorage.setItem(QUEUE_KEY, JSON.stringify(remaining));
    return { flushed, remaining: remaining.length };
  },
};
