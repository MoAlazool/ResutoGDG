// GET /v1/public/floor/the-olive-room/main from the repo demo loader (2026-10-20); ids shortened. No QR tokens or
// internal fields are part of the public floor.
export const DEMO_FLOOR_MAIN = {
 "branchId": "00000000-0000-4000-8000-000000000001",
 "branchCode": "main",
 "revision": 1,
 "width": 1200,
 "height": 800,
 "background": {
  "image": null,
  "opacity": 0.4,
  "locked": true,
  "x": 0,
  "y": 0,
  "width": 1200,
  "height": 800
 },
 "zones": [
  {
   "x": 600,
   "y": 220,
   "id": "zone-main",
   "type": "zone",
   "color": "#e9efe5",
   "label": "Main room",
   "width": 1000,
   "height": 300,
   "rotation": 0
  },
  {
   "x": 600,
   "y": 560,
   "id": "zone-terrace",
   "type": "zone",
   "color": "#f3ead8",
   "label": "Terrace",
   "width": 1000,
   "height": 300,
   "rotation": 0
  }
 ],
 "objects": [
  {
   "x": 600,
   "y": 40,
   "id": "wall-top",
   "type": "wall",
   "label": "North wall",
   "width": 1100,
   "height": 10,
   "rotation": 0
  },
  {
   "x": 120,
   "y": 760,
   "id": "door",
   "type": "door",
   "label": "Entrance",
   "width": 90,
   "height": 20,
   "rotation": 0
  }
 ],
 "tables": [
  {
   "id": "t-t1",
   "label": "T1",
   "capacity": 2,
   "zone": "Main room",
   "shape": "round",
   "cx": 250,
   "cy": 220,
   "width": 90,
   "height": 90,
   "rotation": 0,
   "features": [],
   "reservable": true,
   "minSpendMinor": 0,
   "premium": false
  },
  {
   "id": "t-t2",
   "label": "T2",
   "capacity": 4,
   "zone": "Main room",
   "shape": "square",
   "cx": 500,
   "cy": 220,
   "width": 100,
   "height": 100,
   "rotation": 0,
   "features": [],
   "reservable": true,
   "minSpendMinor": 0,
   "premium": false
  },
  {
   "id": "t-t3",
   "label": "T3",
   "capacity": 4,
   "zone": "Main room",
   "shape": "square",
   "cx": 750,
   "cy": 220,
   "width": 100,
   "height": 100,
   "rotation": 0,
   "features": [],
   "reservable": true,
   "minSpendMinor": 0,
   "premium": false
  },
  {
   "id": "t-t4",
   "label": "T4",
   "capacity": 6,
   "zone": "Terrace",
   "shape": "round",
   "cx": 250,
   "cy": 560,
   "width": 120,
   "height": 120,
   "rotation": 0,
   "features": [
    "Outdoor"
   ],
   "reservable": true,
   "minSpendMinor": 0,
   "premium": false
  },
  {
   "id": "t-t5",
   "label": "T5",
   "capacity": 4,
   "zone": "Terrace",
   "shape": "square",
   "cx": 500,
   "cy": 560,
   "width": 100,
   "height": 100,
   "rotation": 0,
   "features": [
    "Outdoor"
   ],
   "reservable": true,
   "minSpendMinor": 0,
   "premium": false
  },
  {
   "id": "t-t6",
   "label": "T6",
   "capacity": 8,
   "zone": "Terrace",
   "shape": "rect",
   "cx": 750,
   "cy": 560,
   "width": 180,
   "height": 90,
   "rotation": 0,
   "features": [
    "Outdoor"
   ],
   "reservable": true,
   "minSpendMinor": 0,
   "premium": true
  }
 ]
} as const;
