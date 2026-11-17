"""Processed, enriched, transform and metric layers."""
from __future__ import annotations

from .dag import dataset, fk, in_range, rows_equal, scalar
from .stage_source import OPS, WX

DELAYS = "Flight delays"
METRICS = "Aviation metrics"

# Great-circle distance in statute miles (haversine, mean Earth radius 3,958.76 mi).
HAVERSINE = """(2 * 3958.7613 * asin(sqrt(
    pow(sin(radians({lat2} - {lat1}) / 2), 2)
  + cos(radians({lat1})) * cos(radians({lat2})) * pow(sin(radians({lon2} - {lon1}) / 2), 2))))"""

# ------------------------------------------------------------ processed ----

@dataset("processed/flights", group=OPS, layer="processed", inputs=["clean/flights"], pk=["flight_id"],
         checks=[rows_equal("clean/flights"),
                 in_range("dep_delay_group", -2, 12), in_range("distance_group", 1, 11),
                 scalar("status is exhaustive", "select count(*) from {t} where status is null",
                        lambda v: v == 0, "0 flights without a status")],
         description="Flights with derived fields: status, route, 15-minute delay flags and bands, distance band, calendar parts.")
def processed_flights(ctx):
    return """
    select *,
      origin || '-' || dest                                              as route_id,
      case when dep_hhmm is null      then 'cancelled'
           when arr_delay_min is null then 'no_arrival'   -- departed, arrival never recorded (likely diverted)
           else 'completed' end                                          as status,
      dep_delay_min >= 15                                                as dep_del15,
      arr_delay_min >= 15                                                as arr_del15,
      cast(greatest(-2, least(12, floor(dep_delay_min / 15.0))) as int)  as dep_delay_group,
      cast(greatest(-2, least(12, floor(arr_delay_min / 15.0))) as int)  as arr_delay_group,
      cast(least(11, floor(distance_mi / 250.0) + 1) as int)             as distance_group,
      dep_delay_min - arr_delay_min                                      as air_recovery_min,
      cast(isodow(flight_date) as int)                                   as day_of_week,
      cast(date_trunc('week', flight_date) as date)                      as week_start,
      cast(month(flight_date) as int)                                    as month
    from clean__flights
    """


@dataset("processed/aircraft", group=OPS, layer="processed", inputs=["clean/aircraft"], pk=["tail_number"],
         description="Aircraft with age in 2013 and a seat band.")
def processed_aircraft(ctx):
    return """
    select *,
      2013 - year_built                                       as age_years,
      case when seats < 100 then 'Under 100 seats'
           when seats < 200 then '100-199 seats'
           else '200+ seats' end                              as seat_band
    from clean__aircraft
    """


@dataset("processed/airports", group=OPS, layer="processed", inputs=["clean/airports", "clean/flights"],
         pk=["airport_code"],
         checks=[in_range("lat", 15, 65), in_range("lon", -160, -60)],
         description="Only the airports that New York flights actually touch, flagged as origin or destination.")
def processed_airports(ctx):
    return """
    with used as (
      select airport_code, bool_or(is_origin) as is_origin from (
        select origin as airport_code, true as is_origin from clean__flights
        union all
        select dest, false from clean__flights
      ) group by 1
    )
    select a.*, u.is_origin
    from clean__airports a join used u using (airport_code)
    """


@dataset("processed/weather", group=WX, layer="processed", inputs=["clean/weather"], pk=["origin", "obs_hour_utc"],
         checks=[rows_equal("clean/weather")],
         description="Hourly weather with operational flags: low visibility (< 3 mi), precipitation, strong wind, freezing precipitation.")
def processed_weather(ctx):
    return """
    select *,
      coalesce(visibility_mi < 3, false)                                    as wx_low_visibility,
      coalesce(precip_in > 0, false)                                        as wx_precipitation,
      coalesce(wind_speed_mph >= 25, false) or coalesce(wind_gust_mph >= 35, false) as wx_strong_wind,
      coalesce(temp_f <= 32 and precip_in > 0, false)                       as wx_freezing_precip,
      coalesce(visibility_mi < 3, false) or coalesce(precip_in > 0, false)
        or coalesce(wind_speed_mph >= 25, false) or coalesce(wind_gust_mph >= 35, false) as wx_adverse
    from clean__weather
    """


# ------------------------------------------------------------- enriched ----

@dataset("enriched/flights", group=OPS, layer="enriched",
         inputs=["processed/flights", "clean/airlines", "clean/carrier_lookup", "processed/airports",
                 "processed/aircraft", "processed/weather", "clean/distance_group_lookup",
                 "clean/delay_group_lookup"],
         pk=["flight_id"],
         checks=[rows_equal("processed/flights"),
                 fk("carrier", "clean/airlines", "carrier"),
                 fk("dest", "processed/airports", "airport_code"),
                 fk("tail_number", "processed/aircraft", "tail_number", warn_below=1.0, fail_below=0.8),
                 scalar("weather matched at scheduled hour",
                        "select avg(case when wx_matched then 1.0 else 0 end) from {t}",
                        lambda v: v >= 0.98, ">= 98% of flights", warn_only=True, fmt=lambda v: f"{v:.2%}")],
         description="The fan-in: one wide row per flight with airline, both airports, aircraft, band labels and the weather at the origin in the scheduled hour.")
def enriched_flights(ctx):
    return """
    select
      f.*,
      al.airline_name,
      cl.carrier_type,
      o.airport_name   as origin_name,
      d.airport_name   as dest_name,
      d.lat            as dest_lat,
      d.lon            as dest_lon,
      d.time_zone      as dest_time_zone,
      ac.manufacturer, ac.model, ac.seats, ac.year_built, ac.seat_band,
      ac.tail_number is not null as aircraft_matched,
      dg.distance_band,
      lg.delay_band    as dep_delay_band,
      w.obs_hour_utc is not null as wx_matched,
      w.temp_f, w.wind_speed_mph, w.wind_gust_mph, w.precip_in, w.visibility_mi,
      coalesce(w.wx_low_visibility, false)  as wx_low_visibility,
      coalesce(w.wx_precipitation, false)   as wx_precipitation,
      coalesce(w.wx_strong_wind, false)     as wx_strong_wind,
      coalesce(w.wx_freezing_precip, false) as wx_freezing_precip,
      coalesce(w.wx_adverse, false)         as wx_adverse
    from processed__flights f
    left join clean__airlines al              on al.carrier = f.carrier
    left join clean__carrier_lookup cl        on cl.carrier = f.carrier
    left join processed__airports o           on o.airport_code = f.origin
    left join processed__airports d           on d.airport_code = f.dest
    left join processed__aircraft ac          on ac.tail_number = f.tail_number
    left join processed__weather w            on w.origin = f.origin and w.obs_hour_utc = f.sched_hour_utc
    left join clean__distance_group_lookup dg on dg.distance_group = f.distance_group
    left join clean__delay_group_lookup lg    on lg.delay_group = f.dep_delay_group
    """


@dataset("enriched/airports", group=OPS, layer="enriched", inputs=["processed/airports", "processed/flights"],
         pk=["airport_code"],
         description="Airports with traffic: departures, arrivals from New York, carriers and routes served.")
def enriched_airports(ctx):
    return """
    with dep as (
      select origin as airport_code, count(*) as departures, count(distinct carrier) as carriers_out,
             count(distinct dest) as destinations
      from processed__flights group by 1
    ), arr as (
      select dest as airport_code, count(*) as arrivals_from_nyc, count(distinct carrier) as carriers_in,
             count(distinct origin) as nyc_origins
      from processed__flights group by 1
    )
    select a.*,
           coalesce(dep.departures, 0)        as departures,
           coalesce(arr.arrivals_from_nyc, 0) as arrivals_from_nyc,
           coalesce(dep.carriers_out, arr.carriers_in) as carriers,
           coalesce(dep.destinations, arr.nyc_origins) as connected_airports
    from processed__airports a
    left join dep using (airport_code)
    left join arr using (airport_code)
    """


# --------------------------------------------------- flight delays project ----

@dataset("delays/flights", group=DELAYS, layer="transform", inputs=["enriched/flights"], pk=["flight_id"],
         checks=[rows_equal("enriched/flights")],
         description="The flight fact table handed to the ontology: keys, schedule, outcome and weather context.")
def delays_flights(ctx):
    return """
    select flight_id, flight_date, week_start, month, day_of_week, sched_dep_hour, sched_dep_hhmm, sched_arr_hhmm,
           carrier, flight_number, tail_number, aircraft_matched, origin, dest, route_id,
           status, dep_hhmm, arr_hhmm, dep_delay_min, arr_delay_min, dep_del15, arr_del15,
           dep_delay_group, dep_delay_band, air_time_min, air_recovery_min, distance_mi, distance_group,
           distance_band, temp_f, wind_speed_mph, wind_gust_mph, precip_in, visibility_mi, wx_adverse
    from enriched__flights
    """


@dataset("delays/delays", group=DELAYS, layer="transform", inputs=["enriched/flights"], pk=["delay_id"],
         checks=[in_range("worst_delay_min", 15, 1500),
                 scalar("every delay has a severity", "select count(*) from {t} where severity is null",
                        lambda v: v == 0, "0 rows")],
         description="One row per flight that left or arrived at least 15 minutes late, with phase, severity and minutes recovered in the air.")
def delays_delays(ctx):
    return """
    with d as (
      select *, greatest(coalesce(dep_delay_min, -9999), coalesce(arr_delay_min, -9999)) as worst_delay_min
      from enriched__flights
      where coalesce(dep_del15, false) or coalesce(arr_del15, false)
    )
    select 'D-' || flight_id                        as delay_id,
           flight_id, flight_date, carrier, origin, dest, route_id,
           dep_delay_min, arr_delay_min, worst_delay_min,
           case when coalesce(dep_del15, false) and coalesce(arr_del15, false) then 'departure and arrival'
                when coalesce(dep_del15, false) then 'departure only'
                else 'arrival only' end              as phase,
           case when worst_delay_min >= 120 then 'severe'
                when worst_delay_min >= 45  then 'major'
                else 'minor' end                     as severity,
           air_recovery_min,
           wx_adverse                                as adverse_weather_at_origin
    from d
    """


# -------------------------------------------------------------- metrics ----

AGG = """
  count(*)                                                          as flights,
  count(*) filter (status = 'cancelled')                            as cancelled,
  count(*) filter (status <> 'cancelled')                           as departed,
  count(*) filter (status = 'completed')                            as arrived,
  avg(dep_delay_min)                                                as mean_dep_delay,
  avg(arr_delay_min)                                                as mean_arr_delay,
  median(arr_delay_min)                                             as median_arr_delay,
  count(*) filter (dep_del15)                                       as dep_late,
  count(*) filter (arr_del15)                                       as arr_late,
  1 - count(*) filter (arr_del15) / nullif(count(*) filter (status = 'completed'), 0) as on_time_share,
  count(*) filter (status = 'cancelled') / count(*)                 as cancel_rate
"""


@dataset("metrics/airline_fleet", group=METRICS, layer="metrics", inputs=["enriched/flights"],
         pk=["carrier", "manufacturer", "model"],
         description="Per airline and aircraft model: aircraft flown, flights, seats and build year. Registry-matched aircraft only.")
def metrics_airline_fleet(ctx):
    return """
    select carrier, manufacturer, model,
           count(distinct tail_number) as aircraft,
           count(*)                    as flights,
           cast(median(seats) as int)  as seats,
           round(avg(year_built), 1)   as mean_year_built
    from enriched__flights
    where aircraft_matched
    group by all
    """


@dataset("metrics/airline_routes", group=METRICS, layer="metrics", inputs=["enriched/flights"],
         pk=["carrier", "route_id"],
         description="Per airline and route: volume, cancellations, delays and on-time share.")
def metrics_airline_routes(ctx):
    return f"select carrier, route_id, origin, dest, {AGG} from enriched__flights group by all"


@dataset("metrics/airport_flights", group=METRICS, layer="metrics", inputs=["enriched/flights"],
         pk=["airport_code", "role", "month"],
         description="Per airport, role (origin or destination) and month: volume, cancellations and delays.")
def metrics_airport_flights(ctx):
    return f"""
    select origin as airport_code, 'origin' as role, month, {AGG} from enriched__flights group by all
    union all
    select dest, 'destination', month, {AGG} from enriched__flights group by all
    """


@dataset("metrics/route_daily", group=METRICS, layer="metrics", inputs=["delays/flights"],
         pk=["route_id", "flight_date"],
         checks=[scalar("flights conserved", "select sum(flights) from {t}",
                        lambda v: v == 336776, "336,776", fmt=lambda v: f"{int(v):,}")],
         description="Per route and day: scheduled, cancelled, departed, arrived and delay totals. Feeds the alert detectors.")
def metrics_route_daily(ctx):
    return f"""
    select route_id, origin, dest, flight_date, week_start, {AGG},
           sum(dep_delay_min) as sum_dep_delay
    from delays__flights group by all
    """


@dataset("metrics/origin_daily", group=METRICS, layer="metrics", inputs=["delays/flights", "processed/weather"],
         pk=["origin", "flight_date"],
         checks=[scalar("every origin-day present", "select count(*) from {t}", lambda v: v == 3 * 365, "1,095")],
         description="Per New York airport and day: operations plus the day's weather, and a robust disruption score against the previous 28 days.")
def metrics_origin_daily(ctx):
    return f"""
    with ops as (
      select origin, flight_date, {AGG}, sum(dep_delay_min) as sum_dep_delay
      from delays__flights group by all
    ), wx as (
      select origin, obs_date_local as flight_date,
             min(temp_f) as temp_min_f, max(temp_f) as temp_max_f,
             sum(precip_in) as precip_total_in, min(visibility_mi) as visibility_min_mi,
             max(wind_speed_mph) as wind_max_mph, max(wind_gust_mph) as gust_max_mph,
             count(*) filter (wx_adverse) as adverse_hours, count(*) as observed_hours
      from processed__weather group by all
    ), scored as (
      select ops.*,
             median(mean_dep_delay) over w as base_median,
             mad(mean_dep_delay)    over w as base_mad,
             count(*)               over w as base_days
      from ops
      window w as (partition by origin order by flight_date
                   range between interval 28 days preceding and interval 1 day preceding)
    )
    select s.*,
           wx.temp_min_f, wx.temp_max_f, wx.precip_total_in, wx.visibility_min_mi, wx.wind_max_mph,
           wx.gust_max_mph, wx.adverse_hours, wx.observed_hours,
           case when base_days >= 14
                then (mean_dep_delay - base_median) / greatest(1.4826 * base_mad, 2.0) end as disruption_z,
           coalesce(base_days >= 14 and (mean_dep_delay - base_median) / greatest(1.4826 * base_mad, 2.0) >= 3.5
                    and mean_dep_delay >= 30, false)
             or cancel_rate >= 0.10                                                        as disrupted
    from scored s left join wx using (origin, flight_date)
    """


@dataset("metrics/hourly_profile", group=METRICS, layer="metrics", inputs=["delays/flights"],
         pk=["origin", "sched_dep_hour"],
         description="Per origin and scheduled departure hour: how delay builds through the day.")
def metrics_hourly_profile(ctx):
    return f"select origin, sched_dep_hour, {AGG} from delays__flights group by all"


@dataset("metrics/carrier_monthly", group=METRICS, layer="metrics", inputs=["delays/flights"],
         pk=["carrier", "month"], description="Per airline and month.")
def metrics_carrier_monthly(ctx):
    return f"select carrier, month, {AGG} from delays__flights group by all"


@dataset("metrics/weather_delay", group=METRICS, layer="metrics", inputs=["delays/flights"],
         pk=["dimension", "bin_order"],
         description="Departure delay and cancellation by the weather at the origin in the scheduled hour, binned four ways.")
def metrics_weather_delay(ctx):
    def part(dim, expr_order, expr_label, cond):
        return f"""
        select '{dim}' as dimension, {expr_order} as bin_order, {expr_label} as bin, {AGG}
        from delays__flights where {cond} group by all"""
    vis = part("Visibility",
               "case when visibility_mi < 1 then 1 when visibility_mi < 3 then 2 when visibility_mi < 6 then 3 when visibility_mi < 10 then 4 else 5 end",
               "case when visibility_mi < 1 then 'Under 1 mi' when visibility_mi < 3 then '1-3 mi' when visibility_mi < 6 then '3-6 mi' when visibility_mi < 10 then '6-10 mi' else '10 mi (clear)' end",
               "visibility_mi is not null")
    wind = part("Wind speed",
                "case when wind_speed_mph < 5 then 1 when wind_speed_mph < 10 then 2 when wind_speed_mph < 15 then 3 when wind_speed_mph < 20 then 4 when wind_speed_mph < 25 then 5 else 6 end",
                "case when wind_speed_mph < 5 then 'Under 5 mph' when wind_speed_mph < 10 then '5-10 mph' when wind_speed_mph < 15 then '10-15 mph' when wind_speed_mph < 20 then '15-20 mph' when wind_speed_mph < 25 then '20-25 mph' else '25 mph and over' end",
                "wind_speed_mph is not null")
    rain = part("Precipitation",
                "case when precip_in = 0 then 1 when precip_in < 0.05 then 2 when precip_in < 0.15 then 3 else 4 end",
                "case when precip_in = 0 then 'None' when precip_in < 0.05 then 'Trace (under 0.05 in/h)' when precip_in < 0.15 then 'Moderate (0.05-0.15 in/h)' else 'Heavy (0.15 in/h and over)' end",
                "precip_in is not null")
    temp = part("Temperature",
                "case when temp_f < 32 then 1 when temp_f < 50 then 2 when temp_f < 70 then 3 when temp_f < 85 then 4 else 5 end",
                "case when temp_f < 32 then 'Below freezing' when temp_f < 50 then '32-50 F' when temp_f < 70 then '50-70 F' when temp_f < 85 then '70-85 F' else '85 F and over' end",
                "temp_f is not null")
    return " union all ".join([vis, wind, rain, temp])


@dataset("metrics/calendar_heat", group=METRICS, layer="metrics", inputs=["delays/flights"],
         pk=["day_of_week", "sched_dep_hour"],
         description="Day of week by scheduled hour: where in the week delay concentrates.")
def metrics_calendar_heat(ctx):
    return f"select day_of_week, sched_dep_hour, {AGG} from delays__flights group by all"


@dataset("metrics/distance_bands", group=METRICS, layer="metrics", inputs=["delays/flights"],
         pk=["distance_group"],
         description="Per distance band: delays and the minutes flights make up in the air.")
def metrics_distance_bands(ctx):
    return f"""select distance_group, distance_band, {AGG},
                      avg(air_recovery_min) as mean_air_recovery, avg(air_time_min) as mean_air_time
               from delays__flights group by all"""
