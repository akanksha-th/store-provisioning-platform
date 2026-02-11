#!/bin/sh
set -e

echo "=================================="
echo "WooCommerce Automated Setup"
echo "=================================="

cd /var/www/html

# ----------------------------------
# 1. Wait for WordPress core files
# ----------------------------------
echo "Waiting for WordPress core files..."
MAX_TRIES=60
COUNTER=0
until [ -f index.php ] && [ -f wp-settings.php ] && [ -f wp-load.php ]; do
  COUNTER=$((COUNTER + 1))
  if [ $COUNTER -gt $MAX_TRIES ]; then
    echo "ERROR: WordPress core files not found after $MAX_TRIES attempts"
    exit 1
  fi
  echo "  Core files not ready... (attempt $COUNTER/$MAX_TRIES)"
  sleep 3
done
echo "✓ WordPress core files detected"

# ----------------------------------
# 2. Create wp-config.php FIRST
# ----------------------------------
if [ ! -f wp-config.php ]; then
  echo "Creating wp-config.php..."
  wp config create \
    --dbname="$WORDPRESS_DB_NAME" \
    --dbuser="$WORDPRESS_DB_USER" \
    --dbpass="$WORDPRESS_DB_PASSWORD" \
    --dbhost="$WORDPRESS_DB_HOST" \
    --skip-check \
    --allow-root
  echo "✓ wp-config.php created"
else
  echo "✓ wp-config.php already exists"
fi

# ----------------------------------
# 3. Wait for database
# ----------------------------------
echo "Waiting for database to be writable..."
MAX_TRIES=40
COUNTER=0
until wp db query "SELECT 1" --allow-root >/dev/null 2>&1; do
  COUNTER=$((COUNTER + 1))
  if [ $COUNTER -gt $MAX_TRIES ]; then
    echo "ERROR: Database connection timeout after $MAX_TRIES attempts"
    exit 1
  fi
  echo "  Database not writable yet... (attempt $COUNTER/$MAX_TRIES)"
  sleep 5
done
echo "✓ Database is writable"

# ----------------------------------
# 4. Install WordPress
# ----------------------------------
if ! wp core is-installed --allow-root; then
  echo "Installing WordPress..."
  wp core install \
    --url="http://localhost:${STORE_PORT}" \
    --title="WooCommerce Store" \
    --admin_user="admin" \
    --admin_password="admin123" \
    --admin_email="admin@example.com" \
    --skip-email \
    --allow-root
  echo "✓ WordPress installed"
else
  echo "✓ WordPress already installed"
fi

echo "Verifying WordPress tables..."
wp db tables --allow-root | grep wp_options >/dev/null
echo "✓ WordPress tables verified"

# ----------------------------------
# 5. Install WooCommerce
# ----------------------------------
if ! wp plugin is-installed woocommerce --allow-root; then
  echo "Installing WooCommerce..."
  wp plugin install woocommerce --activate --allow-root
else
  wp plugin activate woocommerce --allow-root
fi
echo "✓ WooCommerce ready"

# ----------------------------------
# 6. Run WooCommerce Setup Wizard Programmatically
# ----------------------------------
echo "Configuring WooCommerce..."
wp option update woocommerce_store_address "123 Main St" --allow-root
wp option update woocommerce_store_city "Sample City" --allow-root
wp option update woocommerce_default_country "US:CA" --allow-root
wp option update woocommerce_store_postcode "90210" --allow-root
wp option update woocommerce_currency "USD" --allow-root
wp option update woocommerce_product_type "both" --allow-root
wp option update woocommerce_allow_tracking "no" --allow-root
wp option update woocommerce_enable_taxes "yes" --allow-root
wp option update woocommerce_calc_taxes "yes" --allow-root

# Enable Cash on Delivery
wp option update woocommerce_cod_settings '{"enabled":"yes","title":"Cash on Delivery"}' --format=json --allow-root

echo "✓ WooCommerce configured"

# ----------------------------------
# 7. Create sample products using WP-CLI
# ----------------------------------
echo "Creating sample products..."

# Create product 1
PRODUCT_ID=$(wp post create \
  --post_type=product \
  --post_title='Sample T-Shirt' \
  --post_status=publish \
  --post_content='A comfortable cotton t-shirt' \
  --allow-root \
  --porcelain)

wp post meta update $PRODUCT_ID _regular_price 29.99 --allow-root
wp post meta update $PRODUCT_ID _price 29.99 --allow-root
wp post meta update $PRODUCT_ID _stock_status instock --allow-root
wp post meta update $PRODUCT_ID _manage_stock no --allow-root

echo "✓ Created Sample T-Shirt (ID: $PRODUCT_ID)"

# Create product 2
PRODUCT_ID2=$(wp post create \
  --post_type=product \
  --post_title='Sample Hoodie' \
  --post_status=publish \
  --post_content='A warm and cozy hoodie' \
  --allow-root \
  --porcelain)

wp post meta update $PRODUCT_ID2 _regular_price 59.99 --allow-root
wp post meta update $PRODUCT_ID2 _price 59.99 --allow-root
wp post meta update $PRODUCT_ID2 _stock_status instock --allow-root
wp post meta update $PRODUCT_ID2 _manage_stock no --allow-root

echo "✓ Created Sample Hoodie (ID: $PRODUCT_ID2)"

echo "=================================="
echo "WooCommerce setup COMPLETE"
echo "=================================="
echo "Store URL: http://localhost:${STORE_PORT}"
echo "Admin URL: http://localhost:${STORE_PORT}/wp-admin"
echo "Username: admin"
echo "Password: admin123"
echo "=================================="