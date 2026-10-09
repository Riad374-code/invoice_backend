use axum::Json;
use serde_json::json;

/// Serves OpenAPI 3.0 specification for frontend types and client generation.
pub async fn openapi_spec_handler() -> Json<serde_json::Value> {
    Json(json!({
        "openapi": "3.0.3",
        "info": {
            "title": "LexAudit AI API",
            "version": env!("CARGO_PKG_VERSION"),
            "description": "LexAudit AI Backend API — Single source of truth for audit, tax, and accounting"
        },
        "servers": [
            { "url": "/api/v1" }
        ],
        "paths": {
            "/admin/health": {
                "get": {
                    "summary": "Health Check",
                    "responses": {
                        "200": { "description": "System is healthy" }
                    }
                }
            },
            "/auth/login": {
                "post": {
                    "summary": "Login with Email and Password",
                    "responses": {
                        "200": { "description": "Authenticated successfully" },
                        "401": { "description": "Invalid credentials" }
                    }
                }
            },
            "/auth/refresh": {
                "post": {
                    "summary": "Refresh Access Token with Refresh Rotation",
                    "responses": {
                        "200": { "description": "Tokens refreshed" },
                        "401": { "description": "Invalid or expired refresh token" }
                    }
                }
            },
            "/auth/logout": {
                "post": {
                    "summary": "Logout and revoke active session",
                    "responses": {
                        "200": { "description": "Logged out" }
                    }
                }
            },
            "/me": {
                "get": {
                    "summary": "Get current authenticated user profile",
                    "responses": {
                        "200": { "description": "User details" },
                        "401": { "description": "Unauthenticated" }
                    }
                }
            },
            "/approvals": {
                "get": {
                    "summary": "List approvals for tenant",
                    "responses": {
                        "200": { "description": "List of approvals" },
                        "403": { "description": "Forbidden" }
                    }
                }
            },
            "/approvals/{id}/decide": {
                "post": {
                    "summary": "Decide approval (approve or reject)",
                    "responses": {
                        "200": { "description": "Decision recorded" },
                        "403": { "description": "Forbidden / Self-approval violation" },
                        "409": { "description": "Invalid state transition" }
                    }
                }
            },
            "/audit-events": {
                "get": {
                    "summary": "List audit events for tenant",
                    "responses": {
                        "200": { "description": "List of audit events" }
                    }
                }
            }
        }
    }))
}
