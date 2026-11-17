"""Raw and clean layers: land the source files as delivered, then type and repair them."""
from __future__ import annotations

from . import sources
from .dag import dataset, fk, in_range, rows_equal, scalar
from .sources import REFERENCE, csv

OPS = "Operations source"
WX = "Weather source"
REF = "Reference data"

SRC = sources.prepare()
BTS = "US Bureau of Transportation Statistics on-time data, via nycflights13"

# ------------------------------------------------------------------ raw ----

@dataset("raw/flights", group=OPS, layer="raw", source=BTS,
         description="Every scheduled departure from EWR, JFK and LGA in 2013, as delivered (all text).")
def raw_flights(ctx):
    return f"select * from {csv(SRC / 'flights.csv')}"


@dataset("raw/airlines", group=OPS, layer="raw", source=BTS,
         description="Two-letter carrier codes and names.")
def raw_airlines(ctx):
    return f"select * from {csv(SRC / 'airlines.csv')}"


@dataset("raw/airports", group=OPS, layer="raw", source="openflights.org airport list, via nycflights13",
         description="US airports with coordinates and time zones.")
def raw_airports(ctx):
    return f"select * from {csv(SRC / 'airports.csv')}"


@dataset("raw/aircraft", group=OPS, layer="raw", source="FAA aircraft registry, via nycflights13",
         description="Registry record per tail number: maker, model, year built, seats, engines.")
def raw_aircraft(ctx):
    return f"select * from {csv(SRC / 'planes.csv')}"


@dataset("raw/weather", group=WX, layer="raw", source="NOAA hourly observations (ASOS), via nycflights13",
         description="Hourly surface weather at EWR, JFK and LGA.")
def raw_weather(ctx):
    return f"select * from {csv(SRC / 'weather.csv')}"


@dataset("raw/airports_supplement", group=REF, layer="raw", source="reference/airports_supplement.csv",
         description="Four Caribbean airports served from New York but absent from the airport list.")
def raw_airports_supplement(ctx):
    return f"select * from {csv(REFERENCE / 'airports_supplement.csv')}"


@dataset("raw/carrier_lookup", group=REF, layer="raw", source="reference/carrier_lookup.csv",
         description="Editorial classification of each carrier: network, low-cost or regional.")
def raw_carrier_lookup(ctx):
    return f"select * from {csv(REFERENCE / 'carrier_lookup.csv')}"


@dataset("raw/distance_group_lookup", group=REF, layer="raw", source="reference/distance_group_lookup.csv",
         description="250-mile distance bands, following the BTS distance-group scheme.")
def raw_distance_group_lookup(ctx):
    return f"select * from {csv(REFERENCE / 'distance_group_lookup.csv')}"


@dataset("raw/delay_group_lookup", group=REF, layer="raw", source="reference/delay_group_lookup.csv",
         description="15-minute delay bands, following the BTS delay-group scheme.")
def raw_delay_group_lookup(ctx):
    return f"select * from {csv(REFERENCE / 'delay_group_lookup.csv')}"


# ---------------------------------------------------------------- clean ----

@dataset("clean/flights", group=OPS, layer="clean", inputs=["raw/flights"], pk=["flight_id"],
         checks=[rows_equal("raw/flights"),
                 in_range("distance_mi", 10, 5500),
                 scalar("dates inside 2013", "select count(*) from {t} where year(flight_date) <> 2013",
                        lambda v: v == 0, "0 rows outside 2013")],
         description="Typed flights. 'NA' becomes NULL, times become integers, and each flight gets a readable key.")
def clean_flights(ctx):
    return """
    with typed as (
      select
        make_date(cast(year as int), cast(month as int), cast(day as int))  as flight_date,
        carrier,
        cast(flight as int)                                                 as flight_number,
        nullif(nullif(trim(tailnum), 'NA'), '')                             as tail_number,
        origin,
        dest,
        cast(sched_dep_time as int)                                         as sched_dep_hhmm,
        cast(sched_arr_time as int)                                         as sched_arr_hhmm,
        cast(try_cast(nullif(dep_time, 'NA') as double) as int)             as dep_hhmm,
        cast(try_cast(nullif(arr_time, 'NA') as double) as int)             as arr_hhmm,
        cast(try_cast(nullif(dep_delay, 'NA') as double) as int)            as dep_delay_min,
        cast(try_cast(nullif(arr_delay, 'NA') as double) as int)            as arr_delay_min,
        cast(try_cast(nullif(air_time, 'NA') as double) as int)             as air_time_min,
        cast(distance as int)                                               as distance_mi,
        cast(hour as int)                                                   as sched_dep_hour,
        cast(strptime(time_hour, '%Y-%m-%dT%H:%M:%SZ') as timestamp)        as sched_hour_utc
      from raw__flights
    )
    select
      strftime(flight_date, '%Y%m%d') || '-' || carrier || flight_number || '-' || origin || '-' || dest
        || '-' || lpad(cast(sched_dep_hhmm as varchar), 4, '0')             as flight_id,
      *
    from typed
    """


@dataset("clean/airlines", group=OPS, layer="clean", inputs=["raw/airlines"], pk=["carrier"],
         description="Carrier names with the legal suffix removed for display.")
def clean_airlines(ctx):
    return r"""
    select carrier,
           trim(name)                                                        as legal_name,
           trim(regexp_replace(trim(name), '\s+(Inc\.|Co\.|Corporation)$', '')) as airline_name
    from raw__airlines
    """


@dataset("clean/airports", group=OPS, layer="clean", inputs=["raw/airports", "raw/airports_supplement"],
         pk=["airport_code"],
         checks=[in_range("lat", -90, 90), in_range("lon", -180, 180)],
         description="Airport list plus the four supplemented Caribbean airports, typed.")
def clean_airports(ctx):
    return """
    with unioned as (
      select *, 'airport list' as record_source from raw__airports
      union all
      select *, 'supplement' as record_source from raw__airports_supplement
      where faa not in (select faa from raw__airports)
    )
    select faa                    as airport_code,
           trim(name)             as airport_name,
           cast(lat as double)    as lat,
           cast(lon as double)    as lon,
           cast(alt as int)       as elevation_ft,
           cast(tz as int)        as utc_offset_h,
           nullif(tzone, 'NA')    as time_zone,
           record_source
    from unioned
    """


@dataset("clean/aircraft", group=OPS, layer="clean", inputs=["raw/aircraft"], pk=["tail_number"],
         checks=[in_range("year_built", 1950, 2013), in_range("seats", 1, 500)],
         description="Registry records with maker names normalised (e.g. 'AIRBUS INDUSTRIE' and 'AIRBUS' become Airbus).")
def clean_aircraft(ctx):
    return """
    select tailnum                                             as tail_number,
           try_cast(nullif(year, 'NA') as int)                 as year_built,
           type                                                as aircraft_type,
           case when manufacturer like 'AIRBUS%'               then 'Airbus'
                when manufacturer like 'BOEING%'               then 'Boeing'
                when manufacturer like 'BOMBARDIER%'
                  or manufacturer like 'CANADAIR%'             then 'Bombardier'
                when manufacturer like 'EMBRAER%'              then 'Embraer'
                when manufacturer like 'MCDONNELL DOUGLAS%'
                  or manufacturer = 'DOUGLAS'                  then 'McDonnell Douglas'
                else 'Other' end                               as manufacturer,
           manufacturer                                        as manufacturer_raw,
           model,
           cast(engines as int)                                as engines,
           cast(seats as int)                                  as seats,
           engine                                              as engine_type
    from raw__aircraft
    """


@dataset("clean/weather", group=WX, layer="clean", inputs=["raw/weather"], pk=["origin", "obs_hour_utc"],
         checks=[in_range("wind_speed_mph", 0, 100), in_range("visibility_mi", 0, 10),
                 in_range("temp_f", -20, 110),
                 scalar("hours covered", "select count(*) / (3 * 8760.0) from {t}",
                        lambda v: v >= 0.99, ">= 99% of 3 x 8,760 hours", warn_only=True,
                        fmt=lambda v: f"{v:.2%}")],
         description="Typed hourly weather. One impossible wind reading (1,048 mph at EWR on 12 Feb) is nulled.")
def clean_weather(ctx):
    return """
    with typed as (
      select origin,
             cast(strptime(time_hour, '%Y-%m-%dT%H:%M:%SZ') as timestamp)  as obs_hour_utc,
             make_date(cast(year as int), cast(month as int), cast(day as int)) as obs_date_local,
             cast(hour as int)                                             as obs_hour_local,
             try_cast(nullif(temp, 'NA') as double)                        as temp_f,
             try_cast(nullif(dewp, 'NA') as double)                        as dewpoint_f,
             try_cast(nullif(humid, 'NA') as double)                       as humidity_pct,
             try_cast(nullif(wind_dir, 'NA') as int)                       as wind_dir_deg,
             try_cast(nullif(wind_speed, 'NA') as double)                  as wind_speed_raw,
             try_cast(nullif(wind_gust, 'NA') as double)                   as wind_gust_mph,
             try_cast(nullif(precip, 'NA') as double)                      as precip_in,
             try_cast(nullif(pressure, 'NA') as double)                    as pressure_mb,
             try_cast(nullif(visib, 'NA') as double)                       as visibility_mi,
             row_number() over (partition by origin, time_hour order by 1) as rn
      from raw__weather
    )
    select origin, obs_hour_utc, obs_date_local, obs_hour_local, temp_f, dewpoint_f, humidity_pct,
           wind_dir_deg,
           case when wind_speed_raw <= 100 then wind_speed_raw end         as wind_speed_mph,
           wind_gust_mph, precip_in, pressure_mb, visibility_mi
    from typed where rn = 1
    """


@dataset("clean/carrier_lookup", group=REF, layer="clean", inputs=["raw/carrier_lookup"], pk=["carrier"],
         description="Carrier type per carrier code.")
def clean_carrier_lookup(ctx):
    return "select carrier, carrier_type from raw__carrier_lookup"


@dataset("clean/distance_group_lookup", group=REF, layer="clean", inputs=["raw/distance_group_lookup"],
         pk=["distance_group"], description="Typed distance bands.")
def clean_distance_group_lookup(ctx):
    return """select cast(distance_group as int) as distance_group, cast(min_mi as int) as min_mi,
                     try_cast(max_mi as int) as max_mi, label as distance_band
              from raw__distance_group_lookup"""


@dataset("clean/delay_group_lookup", group=REF, layer="clean", inputs=["raw/delay_group_lookup"],
         pk=["delay_group"], description="Typed delay bands.")
def clean_delay_group_lookup(ctx):
    return """select cast(delay_group as int) as delay_group, try_cast(min_min as int) as min_min,
                     try_cast(max_min as int) as max_min, label as delay_band
              from raw__delay_group_lookup"""
