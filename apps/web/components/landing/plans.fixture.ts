// Captured from GET /v1/public/plans?country=EG on the migrated reference data (2026-10-20), two modules kept.
// Typed against the contract, so a change to PublicPlansResponse breaks the typecheck here before it breaks the page.
import type { PublicPlansResponse } from '@resuto/contracts';

export const PUBLIC_PLANS_EG: PublicPlansResponse = {
  "country": "EG",
  "currency": "EGP",
  "interval": "month",
  "plans": [
    {
      "id": "free",
      "name": "Free QR",
      "nameAr": "QR مجاني",
      "description": "Digital QR menu and table ordering for one branch.",
      "descriptionAr": "قائمة رقمية وطلب الطاولات عبر QR لفرع واحد.",
      "isCustom": false,
      "sortOrder": 0,
      "limits": {
        "staff": 2,
        "branches": 1,
        "orders_per_month": 300,
        "ai_requests_per_month": 0
      },
      "modules": [
        "core"
      ],
      "price": {
        "amountMinor": 0,
        "currency": "EGP",
        "interval": "month",
        "validFrom": "2026-01-01T00:00:00.000Z"
      },
      "prices": {
        "month": {
          "amountMinor": 0,
          "currency": "EGP",
          "interval": "month",
          "validFrom": "2026-01-01T00:00:00.000Z"
        },
        "year": {
          "amountMinor": 0,
          "currency": "EGP",
          "interval": "year",
          "validFrom": "2026-01-01T00:00:00.000Z"
        }
      }
    },
    {
      "id": "starter",
      "name": "Starter",
      "nameAr": "المبتدئ",
      "description": "Operations and online payments for a single branch.",
      "descriptionAr": "التشغيل والمدفوعات الإلكترونية لفرع واحد.",
      "isCustom": false,
      "sortOrder": 1,
      "limits": {
        "staff": 5,
        "branches": 1,
        "orders_per_month": 3000,
        "ai_requests_per_month": 100
      },
      "modules": [
        "core",
        "pay"
      ],
      "price": {
        "amountMinor": 79900,
        "currency": "EGP",
        "interval": "month",
        "validFrom": "2026-01-01T00:00:00.000Z"
      },
      "prices": {
        "month": {
          "amountMinor": 79900,
          "currency": "EGP",
          "interval": "month",
          "validFrom": "2026-01-01T00:00:00.000Z"
        },
        "year": {
          "amountMinor": 799000,
          "currency": "EGP",
          "interval": "year",
          "validFrom": "2026-01-01T00:00:00.000Z"
        }
      }
    },
    {
      "id": "growth",
      "name": "Growth",
      "nameAr": "النمو",
      "description": "Customer communication, marketing and websites.",
      "descriptionAr": "التواصل مع العملاء والتسويق والمواقع الإلكترونية.",
      "isCustom": false,
      "sortOrder": 2,
      "limits": {
        "staff": 15,
        "branches": 2,
        "orders_per_month": 15000,
        "ai_requests_per_month": 1000
      },
      "modules": [
        "core",
        "connect",
        "pay",
        "marketing",
        "studio",
        "intelligence"
      ],
      "price": {
        "amountMinor": 149900,
        "currency": "EGP",
        "interval": "month",
        "validFrom": "2026-01-01T00:00:00.000Z"
      },
      "prices": {
        "month": {
          "amountMinor": 149900,
          "currency": "EGP",
          "interval": "month",
          "validFrom": "2026-01-01T00:00:00.000Z"
        },
        "year": {
          "amountMinor": 1499000,
          "currency": "EGP",
          "interval": "year",
          "validFrom": "2026-01-01T00:00:00.000Z"
        }
      }
    },
    {
      "id": "pro",
      "name": "Pro",
      "nameAr": "الاحترافي",
      "description": "Every Resuto module for multi-branch operators.",
      "descriptionAr": "كل وحدات ريسوتو للمطاعم متعددة الفروع.",
      "isCustom": false,
      "sortOrder": 3,
      "limits": {
        "staff": 100,
        "branches": 10,
        "orders_per_month": 100000,
        "ai_requests_per_month": 10000
      },
      "modules": [
        "core",
        "connect",
        "pay",
        "marketing",
        "driver",
        "studio",
        "finance",
        "compliance",
        "intelligence",
        "mcp"
      ],
      "price": {
        "amountMinor": 299900,
        "currency": "EGP",
        "interval": "month",
        "validFrom": "2026-01-01T00:00:00.000Z"
      },
      "prices": {
        "month": {
          "amountMinor": 299900,
          "currency": "EGP",
          "interval": "month",
          "validFrom": "2026-01-01T00:00:00.000Z"
        },
        "year": {
          "amountMinor": 2999000,
          "currency": "EGP",
          "interval": "year",
          "validFrom": "2026-01-01T00:00:00.000Z"
        }
      }
    },
    {
      "id": "custom",
      "name": "Build Your Resuto",
      "nameAr": "ابنِ ريسوتو الخاص بك",
      "description": "Pick only the modules you need.",
      "descriptionAr": "اختر الوحدات التي تحتاجها فقط.",
      "isCustom": true,
      "sortOrder": 4,
      "limits": {
        "staff": 30,
        "branches": 3,
        "orders_per_month": 30000,
        "ai_requests_per_month": 2000
      },
      "modules": [
        "core"
      ],
      "price": {
        "amountMinor": 29900,
        "currency": "EGP",
        "interval": "month",
        "validFrom": "2026-01-01T00:00:00.000Z"
      },
      "prices": {
        "month": {
          "amountMinor": 29900,
          "currency": "EGP",
          "interval": "month",
          "validFrom": "2026-01-01T00:00:00.000Z"
        },
        "year": {
          "amountMinor": 299000,
          "currency": "EGP",
          "interval": "year",
          "validFrom": "2026-01-01T00:00:00.000Z"
        }
      }
    }
  ],
  "modules": [
    {
      "key": "core",
      "name": "Resuto Core",
      "nameAr": "ريسوتو الأساسي",
      "description": "Menu, QR ordering, reservations, floor, kitchen, inventory, staff.",
      "price": {
        "amountMinor": 0,
        "currency": "EGP",
        "interval": "month",
        "validFrom": "2026-01-01T00:00:00.000Z"
      },
      "prices": {
        "month": {
          "amountMinor": 0,
          "currency": "EGP",
          "interval": "month",
          "validFrom": "2026-01-01T00:00:00.000Z"
        },
        "year": {
          "amountMinor": 0,
          "currency": "EGP",
          "interval": "year",
          "validFrom": "2026-01-01T00:00:00.000Z"
        }
      }
    },
    {
      "key": "connect",
      "name": "Resuto Connect",
      "nameAr": "ريسوتو كونكت",
      "description": "WhatsApp ordering, unified inbox and customer messaging.",
      "price": {
        "amountMinor": 40000,
        "currency": "EGP",
        "interval": "month",
        "validFrom": "2026-01-01T00:00:00.000Z"
      },
      "prices": {
        "month": {
          "amountMinor": 40000,
          "currency": "EGP",
          "interval": "month",
          "validFrom": "2026-01-01T00:00:00.000Z"
        },
        "year": {
          "amountMinor": 400000,
          "currency": "EGP",
          "interval": "year",
          "validFrom": "2026-01-01T00:00:00.000Z"
        }
      }
    }
  ],
  "externalCostsNote": "Resuto subscription fees only. Payment-provider fees, WhatsApp conversation fees and advertising spend are charged by those providers directly to your accounts and are not included.",
  "externalCostsNoteAr": "رسوم اشتراك ريسوتو فقط. رسوم مزودي الدفع ورسوم محادثات واتساب وتكاليف الإعلانات يحصّلها هؤلاء المزودون مباشرة من حساباتك ولا تشملها هذه الأسعار."
};
