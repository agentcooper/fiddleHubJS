String.prototype.containsAny = function() {
	var result = false;
	
	for (var i = 0; i < arguments.length; i++) {
		if (this.indexOf(arguments[i]) != -1) {
			result = true;
			break;
		}
	}
	
	return result;
}

var Router = Backbone.Router.extend({
	initialize: function(app) {
		this.app = app;
	},
	
	routes: {
		"https://github.com/:username/:repo": "process",
		"https://github.com/:username/:repo/": "process",
		"https://github.com/:username/:repo/:type/:branch/*path": "process"
	},

	process: function(username, repo, type, branch, path) {
		this.app.set({
			username: username,
			repo: repo,
			branch: branch || 'master',
			path: path
		});
	}
});

var App = Backbone.Model.extend({
	initialize: function() {
		
		this.set({
			/*
			username: null,
			repo: null,
			*/
			branch: 'master'
		});
		
		this.router = new Router(this);
	},
	
	validate: function(attrs) {
		if (attrs.username || attrs.repo ||
			attrs.username == this.get('username') ||
			attrs.repo == this.get('repo')) {
			return;
		}
	},
	
	updateTree: function() {
		var self = this;
		
		self.trigger('loading:start');
		$.ajax({
		    url: 'https://api.github.com/repos/' + self.get('username') + '/' +
					self.get('repo') + '/git/trees/' + self.get('branch'),
		    data: {
		        'recursive' : '1'
		    },
		    dataType: 'jsonp',

			success: function(res) {
				self.set({
					tree: _.filter(res.data.tree, function(leaf) {
						return leaf.type == 'blob' && leaf.path.containsAny('.js', '.html');
					})
				});
				self.trigger('loading:done');
			}
		});
	},
	
	getBlob: function(sha) {
		var self = this;
		
		self.trigger('loading:start');
		$.ajax({
		    url: 'https://api.github.com/repos/' + self.get('username') + '/' + self.get('repo') + '/git/blobs/' + sha,
		    dataType: 'jsonp',

			success: function(res) {
				self.set({
					blob: res.data.content
				});
				self.trigger('loading:done');
			}
		});
	},
	
	absolutePath: function(rel, raw) {
		var self = this;
		
		return 'https://github.com/' + self.get('username') + '/' + self.get('repo') +
			'/blob/' + self.get('branch') + '/' + rel;
	},

	rawDirectory: function() {
		var self = this,
			dir = app.get('path').lastIndexOf('/');
			folder = (dir != -1) ? app.get('path').slice(0, dir + 1) : '';

		return 'https://raw.github.com/' + self.get('username') + '/' + self.get('repo') + '/' + self.get('branch') + '/' + folder;
	},
	
	httpPOST: function(url, params, target) {
		var form = $('<form/>', {
			method: 'POST',
			action: url,
			target: target
		});

		for (var key in params) {
			$('<input>', {
				type: 'hidden',
				name: key,
				value: params[key]
			}).appendTo(form);
		}

		form.appendTo('body').submit();
	}
});

var FileList = Backbone.View.extend({
	tmpl: "<% _.each(files, function(file) { %> <option><%= file.path %></option> <% }); %>",

	events: {
		'change' : 'changeEvent'
	},

	initialize: function() {
		_.bindAll(this, 'render', 'loading');
		this.model.bind('change:tree', this.render);
		//this.model.bind('loading:start', this.loading);
	},
	
	changeEvent: function() {
		var path = app.absolutePath($(this.el).val());
		app.router.navigate(path, true);
	},

	loading: function() {
		$(this.el).attr('disabled', 'disabled');
		$(this.el).html('<option disabled>Loading</option>');
	},

	render: function() {
		$(this.el).html('<option disabled>' + app.get('repo') + '</option>');
		$(this.el).append(_.template(this.tmpl, { files: this.model.get('tree') })).val(this.model.get('path'));
		$(this.el).removeAttr('disabled');
	}
});

var app, fileListView;

$(function() {
	var base64decode = window.atob || Base64.decode;
	
	app = new App();
	fileListView = new FileList({el: '#files', model: app});

	var treeUpdated = false;

	app.bind("change:repo", function() {
		//console.log('new repo', app.get('repo'));
		treeUpdated = false;
		app.updateTree();
	});
	
	app.bind("change:tree", function() {
		//console.log('new tree!', app.get('tree'));
		treeUpdated = true;
		if (app.get('path')) app.trigger('change:path');
	});
	
	app.bind('change:path', function() {
		if (!treeUpdated) return;
		//console.log('new path', app.get('path'));
		
		var file = _.find(app.get('tree'), function(file) {
			return file.path == app.get('path');
		});
	
		if (file && file.sha) app.getBlob(file.sha);
		
		$('#originalLink').attr('href', app.absolutePath(app.get('path')));
	});
	
	app.bind('change:blob', function() {
		var plainText = "",
			fullPath = new URI(app.rawDirectory()),
			fiddleScript,
			fiddleBody;

		_.each(app.get('blob').split('\n'), function(line) {
			plainText += base64decode(line);
		});

		//console.log(plainText);

		switch (app.get('path').split('.').pop().toLowerCase()) {
			case 'html':
				var dom = document.createElement('html');
				dom.innerHTML = plainText;

				var z = $(dom),
					scriptIncl = $('script[src]', z),
					scriptCode = $('script:not([src])', z);

				scriptCode.detach();

				/*
				resolve links inline
				$.each(scriptIncl, function(i, el) {
					$(el).attr('src', function(i, src) {
						var rel = new URI(src),
							absolute = rel.resolve(new URI(app.rawDirectory()));

						return absolute.toString();
					});
				});
				*/

				var res = $.map(scriptIncl, function(el) {
					var rel = new URI($(el).attr('src')),
						absolute = rel.resolve(fullPath);

					//console.log('resolved', rel, absolute);

					return absolute.toString();
				});
				scriptIncl.detach();

				fiddleBody = z.find('head').html() + '\n' + z.find('body').html();
				fiddleScript = scriptCode.html();
				
				break;
				
			case 'js':
				fiddleBody = '';
				fiddleScript = plainText;
				
				break; 
		}

		app.httpPOST('http://jsfiddle.net/api/post/jQuery/1.7/', {
			'js': fiddleScript,
			'html': fiddleBody,
			'resources': res && res.join(',')
		}, 'fiddleFrame');
	});
	
	app.bind('loading:start', function() {
		$('#indicator').show();
	});
	
	app.bind('loading:done', function() {
		$('#indicator').hide();
	});

	Backbone.history.start();
});