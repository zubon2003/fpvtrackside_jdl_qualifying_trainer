name = "Qualifying (90s JDL STYLE)"
description = "Staggered start. Counts laps started within 90s of each pilot's holeshot. Ranked by laps, then time."

-- ===== Config =====

-- Length of the counting window, in seconds, starting from each pilot's holeshot
-- (the moment they first cross the gate). A lap counts if the pilot crossed the
-- gate to start it within the window -- that lap then counts in full, even if it
-- finishes after the window has closed.
local WINDOW = 90

-- "best"  : rank each pilot by their single best run in the stage
-- "total" : rank by total laps across all runs in the stage, then total time
local MODE = "best"

-- ===== Helpers =====

local EPS = 0.0005   -- tolerance so a crossing at exactly 90.000 still counts

local function format_time(seconds)
    if seconds <= 0 then return "-" end
    local mins = math.floor(seconds / 60)
    local secs = seconds - mins * 60
    if mins > 0 then
        return string.format("%d:%06.3f", mins, secs)
    end
    return string.format("%.3f", secs)
end

-- number of rounds in this stage (offset -1 is the last round of the stage)
local function stage_round_count()
    local info = get_round_info(-1)
    if info == nil then return 0 end
    return info.stage_index
end

-- One run = one round's flying for a pilot.
-- The holeshot lap is excluded, so the clock starts at the pilot's first gate
-- crossing. This makes a staggered start irrelevant: every pilot is timed from
-- their own holeshot, not from a shared race start.
local function get_run(pilot_id, offset)
    local lap_times = get_lap_times(pilot_id, offset, false)
    if #lap_times == 0 then return nil end

    -- A lap counts if the gate crossing that STARTS it happened within the window.
    -- Once started, the lap is valid even if it finishes after the window closes,
    -- so the counted time can exceed WINDOW.
    local laps, elapsed, cumulative = 0, 0, 0
    for _, lap in ipairs(lap_times) do
        if cumulative > WINDOW + EPS then
            break            -- this lap was started after the window closed
        end
        cumulative = cumulative + lap
        laps = laps + 1
        elapsed = cumulative -- total time to complete all counted laps
    end

    if laps == 0 then return nil end
    return { laps = laps, time = elapsed, offset = offset }
end

local function collect_runs(pilot_id)
    local n = stage_round_count()
    local runs = {}
    for i = 1, n do
        local offset = i - n - 1      -- stage index i -> round offset
        local run = get_run(pilot_id, offset)
        if run then table.insert(runs, run) end
    end
    return runs
end

-- most laps wins; tie broken by the shorter time
local function better(a, b)
    if a == nil then return b end
    if b == nil then return a end
    if b.laps > a.laps then return b end
    if b.laps == a.laps and b.time < a.time then return b end
    return a
end

local function score(pilot_id)
    local runs = collect_runs(pilot_id)
    if MODE == "total" then
        local laps, time = 0, 0
        for _, r in ipairs(runs) do
            laps = laps + r.laps
            time = time + r.time
        end
        return laps, time
    end

    local best = nil
    for _, r in ipairs(runs) do best = better(best, r) end
    if best == nil then return 0, 0 end
    return best.laps, best.time
end

-- ===== Standings =====

function standings(pilots, options)
    local scored = {}
    for _, p in ipairs(pilots) do
        local laps, time = score(p.id)
        table.insert(scored, { id = p.id, name = p.name, laps = laps, time = time })
    end

    table.sort(scored, function(a, b)
        if a.laps ~= b.laps then return a.laps > b.laps end  -- 1st: lap count
        if a.laps == 0 then return a.name < b.name end
        return a.time < b.time                                -- 2nd: time for those laps
    end)

    local rows = {}
    for _, p in ipairs(scored) do
        table.insert(rows, {
            pilot_id = p.id,
            name = p.name,
            values = { format_time(p.time), tostring(p.laps) },
        })
    end

    return { headings = { "Time", "Laps" }, rows = rows }
end

-- ===== Round generation =====
-- Heat generation is disabled: this is a results-only stage. Heats are built
-- by hand (Add Round -> Empty / Custom Round), and standings() ranks whatever
-- races exist in the stage. Returning nil leaves all existing races untouched.
--
-- NOTE: because generate() returns nil, round.event_type is NOT applied here.
-- Create the qualifying rounds as Time Trial yourself so staggered start stays
-- available (staggered start only works on Time Trial rounds).

function generate(round, pilots, channels, options)
    return nil
end
