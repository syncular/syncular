#[path = "generated/syncular.rs"]
pub mod generated;

#[path = "generated/migrations.rs"]
pub mod migrations;

#[cfg(feature = "demo-todo-native-fixture")]
#[path = "generated/diesel_tables.rs"]
pub mod diesel_tables;

#[cfg(feature = "demo-todo-native-fixture")]
#[path = "generated/schema.rs"]
pub mod schema;

#[cfg(feature = "demo-todo-native-fixture")]
pub mod rusqlite_sqlite;

#[cfg(feature = "demo-todo-native-fixture")]
pub(crate) mod tasks;

#[cfg(feature = "demo-todo-native-fixture")]
pub fn app_schema() -> crate::app_schema::AppSchema {
    crate::app_schema::AppSchema {
        app_tables: generated::APP_TABLES,
        app_table_metadata: generated::APP_TABLE_METADATA,
        migrations: migrations::MIGRATIONS,
        schema_version: None,
        default_subscriptions: generated::default_subscriptions,
        adapter_for: diesel_tables::adapter_for,
    }
}

#[cfg(all(feature = "demo-todo-fixture", not(feature = "native")))]
pub fn app_schema() -> crate::app_schema::AppSchema {
    crate::app_schema::AppSchema {
        app_tables: generated::APP_TABLES,
        app_table_metadata: generated::APP_TABLE_METADATA,
        migrations: migrations::MIGRATIONS,
        schema_version: None,
        default_subscriptions: generated::default_subscriptions,
    }
}
