CLEAN =

all: dist/server.js

node_modules: package.json
	yarn install

dist/server.js: node_modules dist/vendor.js src/server.js src/index.html src/assets.js
	yarn run build:server
CLEAN+=dist/server.js

dist/vendor.js: node_modules src/vendor.js
	yarn run build:vendor
CLEAN+=dist/vendor.js

clean:
	rm $(CLEAN)

.PHONY: all
