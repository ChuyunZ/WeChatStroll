# Primary User and Core Use Case

## Product Problem

People often want to take a casual walk when they are in an unfamiliar
area, but they may not know which nearby places are suitable for walking
or match their personal preferences.

Traditional map applications are mainly designed to help users travel
from one destination to another. Route suggestions are usually based on
factors such as distance, travel time, and popular destinations.

However, users who simply want to take a recreational walk may not have
a specific destination in mind.

They may instead care about questions such as:

- How long do I want to walk?
- What type of environment do I prefer?
- Do I want a quiet or lively area?
- What interesting places can I see along the way?

WeChatStroll aims to generate walking routes based on the user's current
location, available walking time, and preferences.

---

## Primary User

The primary users of WeChatStroll are young users who want to explore
unfamiliar areas through walking but do not know which nearby routes
match their available time and personal preferences.

For example, the user may be:

- Visiting a new city
- Staying in an unfamiliar neighborhood
- Exploring an area around a hotel, university, workplace, or shopping area

These users want to explore their surroundings without spending a large
amount of time manually searching for destinations and planning a route.

---

## Core Use Case

A user arrives in an unfamiliar area and wants to take a casual walk.

For example:

A user arrives in Wuhan and has 30 minutes available before their next
activity. They want to take a quiet walk near their hotel but do not know
which nearby streets, parks, or riverside areas are suitable.

The user opens WeChatStroll.

Instead of entering a specific destination, the user answers several
predefined questions.

For example:

**Walking duration**

- 30 minutes
- 45 minutes
- 60 minutes

**Preferred environment**

- Parks
- Riverside
- City streets
- Mixed

**Preferred crowd level**

- Quiet
- Moderate
- Lively

Using the user's current location and selected preferences, WeChatStroll
generates a nearby walking route.

The route recommendation may include:

- Estimated walking duration
- Estimated walking distance
- Route path
- Interesting locations or stops along the route
- A short description of the walking environment

If the user does not like the recommended route, they can request another
route.

---

## User Stories

- As a user, I want to choose how long I want to walk so that the route
  fits my available time.

- As a user, I want to choose my preferred walking environment so that
  the route matches my interests.

- As a user, I want to choose my preferred crowd level so that the
  walking environment feels comfortable to me.

- As a user, I want to receive a walking route without selecting a
  specific destination so that I can easily explore an unfamiliar area.

- As a user, I want to understand what I can expect to see along a route
  so that I can decide whether I am interested in walking it.

- As a user, I want to request another route if I do not like the current
  recommendation.

- As a user, I want to provide feedback after finishing a walk so that
  future route recommendations can be improved.

---

## Secondary Use Cases

Although the primary use case focuses on exploring unfamiliar areas,
the same route recommendation system can support other scenarios.

For example, an office worker may have 30 minutes after lunch and want
to take a short walk near the workplace.

The same basic interaction applies:

Current Location
→ Available Walking Time
→ User Preferences
→ Recommended Walking Route

These scenarios may be explored after the core MVP experience has been
validated.