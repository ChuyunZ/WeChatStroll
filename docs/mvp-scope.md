# WeChatStroll MVP Scope

This document defines the agreed MVP scope, feature priorities, non-goals, and technical boundaries for WeChatStroll.
## Goal

Define the scope of the first usable version of WeChatStroll.

The MVP should focus on proving the complete core experience:

**Walking Preferences → Current Location → Nearby POIs → AI Route Planning → Real Walking Route → Walk → Feedback**

The MVP should remain small enough for a two-person team to build reliably within the planned development schedule.

---

## MVP User Flow

The core MVP should support the following flow:

1. User opens the Mini Program
2. User answers structured walking preference questions
3. App obtains the user's current location
4. System searches for nearby real-world POIs using the map service
5. AI selects and combines suitable POIs into waypoint plans
6. Map service calculates real walkable routes between the selected waypoints
7. System validates route duration and distance
8. System returns up to three suitable route recommendations
9. User selects one route
10. User views the route details and route on the map
11. User starts the walk
12. User finishes the walk
13. User submits route and crowd feedback

---

## P0 — Required MVP Features

These features are required for the core MVP.

### Walking Preferences

- Walking duration selection
  - 30 minutes
  - 45 minutes
  - 60 minutes
- Environment preference selection
- Crowd preference selection
- Structured questionnaire only
- No free-form natural-language input is required for the MVP

### Location and Map

- Obtain the user's current location
- Handle location permission
- Search nearby real-world POIs
- Retrieve real POI coordinates and metadata
- Request walking directions from the map service
- Display the generated walking route on the map

### AI-Assisted Route Generation

- Send user preferences and real nearby POIs to the AI route planner
- AI selects suitable POIs
- AI combines POIs into waypoint plans
- AI determines waypoint order
- AI generates alternative route candidates

The AI must only select from POIs returned by the map service.

### Route Validation

- Calculate actual walking distance
- Calculate estimated walking duration
- Compare generated route duration with the user's requested duration
- Reject routes that are significantly too long or too short
- Try another waypoint combination when necessary

### Route Recommendations

- Return up to three suitable route recommendations
- Show estimated duration
- Show distance
- Show environment type
- Show main POIs
- Allow the user to select a route
- Display selected route on the map

### Walking Session

- Start walk
- Record start time
- Finish walk
- Record end time
- Record completion status

### Feedback

- Overall route rating
- Observed crowd level
- Would recommend: Yes / No
- Optional comment

---

## P1 — Should Have

These features are useful but should not block completion of the core MVP.

- Basic walking history
- Route descriptions
- Recommendation reasons
- Try Another Route
- Basic personalization using previous feedback
- Basic badge system
- Favorite routes
- Walk Again

If the project falls behind schedule, these features may be postponed.

---

## Out of Scope for the MVP

The following features will not be required for the first MVP:

- Stranger walking partner matching
- Real-time chat
- Large-scale social network features
- City-wide or large-scale leaderboard
- Full personality test
- Annual walking summary
- Real-time turn-by-turn navigation
- Nationwide route coverage
- Advanced achievement system
- Advanced social features

These may be considered in future versions after the core product is stable.

---

## Technical Non-Goals

The AI route planner should NOT:

- Invent POIs
- Invent latitude or longitude coordinates
- Invent roads
- Generate raw geographic paths
- Assume that a route is walkable without map validation

The AI is responsible for deciding:

- Which real POIs are suitable
- Which POIs should be combined
- The order in which POIs should be visited
- Which route plan best matches user preferences

The map service is responsible for:

- Current location
- Nearby POI search
- Real POI coordinates
- Real road information
- Walking directions
- Distance
- Estimated walking duration
- Route polyline

---

## MVP Success Definition

The MVP is considered successful when a real user can complete the following flow without developer assistance:

**Open App**

↓

**Answer Walking Preference Questions**

↓

**Share Current Location**

↓

**System Finds Nearby Real POIs**

↓

**AI Creates Waypoint Plans**

↓

**Map Service Calculates Real Walking Routes**

↓

**System Validates Route Duration**

↓

**User Receives Route Recommendations**

↓

**User Selects a Route**

↓

**User Views the Route on the Map**

↓

**User Starts and Finishes the Walk**

↓

**User Submits Feedback**
