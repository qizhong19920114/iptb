CLEAN =

all: dist/server.bundle.js

node_modules: package.json
	yarn install

dist/server.bundle.js: node_modules dist/postmsg.bundle.js src/server.js dist/index.html src/assets.js
	yarn run webpack-cli --target node -p --mode production --entry ./src/server.js --output ./dist/server.bundle.js --module-bind 'html=raw-loader' --module-bind 'bundle.js=raw-loader' --module-bind 'min.js=raw-loader'
CLEAN+=server.bundle.js

dist/postmsg.bundle.js: node_modules src/postmsg.js
	yarn run webpack-cli --target web --output-library-target umd -p --mode production --entry ./src/postmsg.js --output ./dist/postmsg.bundle.js
CLEAN+=index.bundle.js

dist/index.html: src/index.html
	cp src/index.html ./dist

clean:
	rm $(CLEAN)

.PHONY: all
