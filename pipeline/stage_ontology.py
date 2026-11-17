"""Ontology layer: one backing dataset per object type, plus the object and link definitions.

A backing dataset has a primary key, foreign keys to other objects and the
properties shown in the app. ONTOLOGY describes how those tables become
object types, link types and actions; run.py writes it out as JSON for the app.
"""
from __future__ import annotations

from .dag import dataset, fk, rows_equal, scalar
from .stage_model import AGG, HAVERSINE

ONT = "Aviation ontology"

# ----------------------------------------------------- backing datasets ----

@dataset("ontology/airline", group=ONT, layer="ontology",
         inputs=["clean/airlines", "clean/carrier_lookup", "delays/flights", "metrics/airline_fleet"],
         pk=["airline_id"],
         checks=[scalar("flights conserved", "select sum(flights) from {t}", lambda v: v == 336776, "336,776",
                        fmt=lambda v: f"{int(v):,}")],
         description="Backing table for Airline.")
def ont_airline(ctx):
    return f"""
    with f as (
      select carrier, {AGG}, count(distinct route_id) as routes, count(distinct tail_number) as tails_flown
      from delays__flights group by 1
    ), fleet as (
      select carrier, sum(aircraft) as registry_aircraft, count(*) as models from metrics__airline_fleet group by 1
    )
    select a.carrier as airline_id, a.airline_name, a.legal_name, cl.carrier_type,
           f.flights, f.routes, f.cancelled, f.cancel_rate, f.on_time_share,
           f.mean_dep_delay, f.mean_arr_delay, f.median_arr_delay, f.tails_flown,
           coalesce(fleet.registry_aircraft, 0) as registry_aircraft, coalesce(fleet.models, 0) as models
    from clean__airlines a
    join f using (carrier)
    left join clean__carrier_lookup cl using (carrier)
    left join fleet using (carrier)
    """


@dataset("ontology/aircraft", group=ONT, layer="ontology", inputs=["processed/aircraft", "delays/flights"],
         pk=["aircraft_id"],
         checks=[fk("airline_id", "ontology/airline", "airline_id")],
         description="Backing table for Aircraft: registry-matched tail numbers that flew, with their main operator.")
def ont_aircraft(ctx):
    return """
    with f as (
      select tail_number, count(*) as flights, mode(carrier) as airline_id,
             count(distinct carrier) as operators, count(distinct route_id) as routes,
             avg(arr_delay_min) as mean_arr_delay,
             sum(distance_mi) filter (status <> 'cancelled') as miles_flown
      from delays__flights where aircraft_matched group by 1
    )
    select ac.tail_number as aircraft_id, f.airline_id, ac.manufacturer, ac.model, ac.year_built, ac.age_years,
           ac.seats, ac.seat_band, ac.engines, ac.engine_type, ac.aircraft_type,
           f.flights, f.routes, f.operators, f.mean_arr_delay, f.miles_flown
    from processed__aircraft ac join f using (tail_number)
    """


@dataset("ontology/airport", group=ONT, layer="ontology", inputs=["enriched/airports", "delays/flights"],
         pk=["airport_id"],
         description="Backing table for Airport: location, traffic and punctuality in its role.")
def ont_airport(ctx):
    return """
    with o as (
      select origin as airport_id, avg(dep_delay_min) as mean_dep_delay,
             1 - count(*) filter (dep_del15) / nullif(count(*) filter (status <> 'cancelled'), 0) as on_time_share,
             count(*) filter (status = 'cancelled') / count(*) as cancel_rate
      from delays__flights group by 1
    ), d as (
      select dest as airport_id, avg(arr_delay_min) as mean_arr_delay,
             1 - count(*) filter (arr_del15) / nullif(count(*) filter (status = 'completed'), 0) as on_time_share,
             count(*) filter (status = 'cancelled') / count(*) as cancel_rate
      from delays__flights group by 1
    )
    select a.airport_code as airport_id, a.airport_name, a.lat, a.lon, a.elevation_ft, a.time_zone,
           a.record_source, a.is_origin,
           case when a.is_origin then 'New York origin' else 'Destination' end as role,
           case when a.is_origin then a.departures else a.arrivals_from_nyc end as flights,
           a.carriers, a.connected_airports,
           case when a.is_origin then o.mean_dep_delay else d.mean_arr_delay end as mean_delay,
           case when a.is_origin then o.on_time_share else d.on_time_share end as on_time_share,
           case when a.is_origin then o.cancel_rate else d.cancel_rate end as cancel_rate
    from enriched__airports a
    left join o on o.airport_id = a.airport_code
    left join d on d.airport_id = a.airport_code
    """


@dataset("ontology/route", group=ONT, layer="ontology", inputs=["delays/flights", "enriched/airports"],
         pk=["route_id"],
         checks=[fk("origin_airport_id", "ontology/airport", "airport_id"),
                 fk("dest_airport_id", "ontology/airport", "airport_id"),
                 scalar("reported distance within 2% of great-circle",
                        "select count(*) from {t} where abs(distance_mi - great_circle_mi) / great_circle_mi > 0.02",
                        lambda v: v == 0, "0 routes off by more than 2%", warn_only=True,
                        fmt=lambda v: f"{v} routes off by more than 2%")],
         description="Backing table for Route: an origin-destination pair with volume, punctuality and geometry.")
def ont_route(ctx):
    gc = HAVERSINE.format(lat1="o.lat", lon1="o.lon", lat2="d.lat", lon2="d.lon")
    return f"""
    with r as (
      select route_id, origin, dest, {AGG},
             count(distinct carrier)                 as carriers,
             mode(distance_mi)                       as distance_mi,
             median(air_time_min)                    as median_air_time,
             avg(air_recovery_min)                   as mean_air_recovery,
             quantile_cont(arr_delay_min, 0.9)       as p90_arr_delay,
             count(distinct flight_date)             as days_operated
      from delays__flights group by all
    )
    select r.route_id, r.origin || ' → ' || r.dest as route_name,
           r.origin as origin_airport_id, r.dest as dest_airport_id, d.airport_name as dest_name,
           r.flights, r.cancelled, r.departed, r.arrived, r.cancel_rate, r.on_time_share,
           r.mean_dep_delay, r.mean_arr_delay, r.median_arr_delay, r.p90_arr_delay,
           r.carriers, r.days_operated, r.distance_mi, round({gc}, 1) as great_circle_mi,
           r.median_air_time, r.mean_air_recovery
    from r
    join enriched__airports o on o.airport_code = r.origin
    join enriched__airports d on d.airport_code = r.dest
    """


@dataset("ontology/origin_day", group=ONT, layer="ontology", inputs=["metrics/origin_daily"],
         pk=["origin_day_id"],
         checks=[fk("airport_id", "ontology/airport", "airport_id")],
         description="Backing table for Origin Day: one New York airport on one day, operations and weather together.")
def ont_origin_day(ctx):
    return """
    select origin || '_' || strftime(flight_date, '%Y-%m-%d') as origin_day_id,
           origin as airport_id, flight_date,
           flights, cancelled, departed, cancel_rate, mean_dep_delay,
           dep_late / nullif(departed, 0) as dep_late_share,
           temp_min_f, temp_max_f, precip_total_in, visibility_min_mi, wind_max_mph, gust_max_mph,
           adverse_hours, observed_hours, disruption_z, disrupted
    from metrics__origin_daily
    """


@dataset("ontology/flight", group=ONT, layer="ontology", inputs=["delays/flights"], pk=["flight_id"],
         checks=[rows_equal("raw/flights"),
                 fk("airline_id", "ontology/airline", "airline_id"),
                 fk("origin_airport_id", "ontology/airport", "airport_id"),
                 fk("dest_airport_id", "ontology/airport", "airport_id"),
                 fk("route_id", "ontology/route", "route_id"),
                 fk("origin_day_id", "ontology/origin_day", "origin_day_id"),
                 fk("aircraft_id", "ontology/aircraft", "aircraft_id")],
         description="Backing table for Flight: every raw record, with a foreign key to each linked object.")
def ont_flight(ctx):
    return """
    select flight_id, flight_date, carrier || ' ' || flight_number as flight_name,
           carrier as airline_id, flight_number,
           case when aircraft_matched then tail_number end as aircraft_id, tail_number,
           origin as origin_airport_id, dest as dest_airport_id, route_id,
           origin || '_' || strftime(flight_date, '%Y-%m-%d') as origin_day_id,
           sched_dep_hhmm, sched_arr_hhmm, dep_hhmm, arr_hhmm, status,
           dep_delay_min, arr_delay_min, dep_delay_band, air_time_min, air_recovery_min,
           distance_mi, distance_band, visibility_mi, wind_speed_mph, precip_in, wx_adverse
    from delays__flights
    """


@dataset("ontology/delay", group=ONT, layer="ontology", inputs=["delays/delays"], pk=["delay_id"],
         checks=[fk("flight_id", "ontology/flight", "flight_id")],
         description="Backing table for Delay: one per flight that ran at least 15 minutes late.")
def ont_delay(ctx):
    return """
    select delay_id, flight_id, flight_date, route_id, carrier as airline_id,
           phase, severity, dep_delay_min, arr_delay_min, worst_delay_min, air_recovery_min,
           adverse_weather_at_origin
    from delays__delays
    """


@dataset("ontology/route_alert", group=ONT, layer="ontology", inputs=["alerts/route_alerts"], pk=["alert_id"],
         checks=[fk("route_id", "ontology/route", "route_id"),
                 fk("origin_day_id", "ontology/origin_day", "origin_day_id")],
         description="Backing table for Route Alert. Every alert starts in the 'open' state; the app records triage on top.")
def ont_route_alert(ctx):
    return "select *, 'open' as initial_status from alerts__route_alerts"


@dataset("ontology/airline_route", group=ONT, layer="ontology", inputs=["metrics/airline_routes"],
         pk=["airline_id", "route_id"],
         checks=[fk("airline_id", "ontology/airline", "airline_id"), fk("route_id", "ontology/route", "route_id")],
         description="Join table behind the many-to-many link between Airline and Route.")
def ont_airline_route(ctx):
    return """
    select carrier as airline_id, route_id, flights, cancelled, cancel_rate, on_time_share,
           mean_dep_delay, mean_arr_delay
    from metrics__airline_routes
    """


# -------------------------------------------------- ontology definition ----

ONTOLOGY = {
    "objectTypes": [
        {"id": "airline", "name": "Airline", "plural": "Airlines", "backing": "ontology/airline",
         "pk": "airline_id", "title": "airline_name",
         "description": "A carrier operating flights out of New York."},
        {"id": "aircraft", "name": "Aircraft", "plural": "Aircraft", "backing": "ontology/aircraft",
         "pk": "aircraft_id", "title": "aircraft_id",
         "description": "A registered airframe, identified by tail number."},
        {"id": "airport", "name": "Airport", "plural": "Airports", "backing": "ontology/airport",
         "pk": "airport_id", "title": "airport_name",
         "description": "A New York origin or one of its destinations."},
        {"id": "route", "name": "Route", "plural": "Routes", "backing": "ontology/route",
         "pk": "route_id", "title": "route_name",
         "description": "A directed origin-destination pair."},
        {"id": "flight", "name": "Flight", "plural": "Flights", "backing": "ontology/flight",
         "pk": "flight_id", "title": "flight_name",
         "description": "One scheduled departure."},
        {"id": "delay", "name": "Delay", "plural": "Delays", "backing": "ontology/delay",
         "pk": "delay_id", "title": "delay_id",
         "description": "A flight that left or arrived at least 15 minutes late."},
        {"id": "origin_day", "name": "Origin Day", "plural": "Origin Days", "backing": "ontology/origin_day",
         "pk": "origin_day_id", "title": "origin_day_id",
         "description": "One New York airport on one day: operations and weather."},
        {"id": "route_alert", "name": "Route Alert", "plural": "Route Alerts", "backing": "ontology/route_alert",
         "pk": "alert_id", "title": "title",
         "description": "A detector finding on a route that someone should look at."},
    ],
    "linkTypes": [
        {"from": "flight", "to": "airline", "via": "airline_id", "cardinality": "many-to-one", "name": "operated by"},
        {"from": "flight", "to": "aircraft", "via": "aircraft_id", "cardinality": "many-to-one", "name": "flown on"},
        {"from": "flight", "to": "airport", "via": "origin_airport_id", "cardinality": "many-to-one", "name": "departs from"},
        {"from": "flight", "to": "airport", "via": "dest_airport_id", "cardinality": "many-to-one", "name": "arrives at"},
        {"from": "flight", "to": "route", "via": "route_id", "cardinality": "many-to-one", "name": "flies"},
        {"from": "flight", "to": "origin_day", "via": "origin_day_id", "cardinality": "many-to-one", "name": "departs on"},
        {"from": "delay", "to": "flight", "via": "flight_id", "cardinality": "one-to-one", "name": "delay of"},
        {"from": "route", "to": "airport", "via": "origin_airport_id", "cardinality": "many-to-one", "name": "starts at"},
        {"from": "route", "to": "airport", "via": "dest_airport_id", "cardinality": "many-to-one", "name": "ends at"},
        {"from": "airline", "to": "route", "via": "ontology/airline_route", "cardinality": "many-to-many", "name": "serves"},
        {"from": "aircraft", "to": "airline", "via": "airline_id", "cardinality": "many-to-one", "name": "mainly operated by"},
        {"from": "origin_day", "to": "airport", "via": "airport_id", "cardinality": "many-to-one", "name": "day at"},
        {"from": "route_alert", "to": "route", "via": "route_id", "cardinality": "many-to-one", "name": "raised on"},
        {"from": "route_alert", "to": "origin_day", "via": "origin_day_id", "cardinality": "many-to-one", "name": "context"},
    ],
    "actions": {
        "route_alert": {
            "property": "status",
            "states": ["open", "acknowledged", "investigating", "resolved", "dismissed"],
            "initial": "open",
            "transitions": {
                "open": ["acknowledged", "dismissed"],
                "acknowledged": ["investigating", "resolved", "dismissed"],
                "investigating": ["resolved", "dismissed"],
                "resolved": ["open"],
                "dismissed": ["open"],
            },
            "labels": {
                "acknowledged": "Acknowledge", "investigating": "Start investigating",
                "resolved": "Resolve", "dismissed": "Dismiss", "open": "Reopen",
            },
        }
    },
}
