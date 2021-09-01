import React from 'react';
import PropTypes from 'prop-types';
import { Tail } from 'tail';
import os from 'os';
import { ipcRenderer } from 'electron'; // eslint-disable-line import/no-extraneous-dependencies
import sanitizeHtml from 'sanitize-html';

import Row from 'react-bootstrap/Row';
import Col from 'react-bootstrap/Col';
import Container from 'react-bootstrap/Container';

import { ipcMainChannels } from '../../../main/ipcMainChannels';

const logger = window.Workbench.getLogger('LogTab');

const LOG_TEXT_TAG = 'span';
const ALLOWED_HTML_OPTIONS = {
  allowedTags: [LOG_TEXT_TAG],
  allowedAttributes: { [LOG_TEXT_TAG]: ['class'] },
};
const LOG_ERROR_REGEX = /(Traceback)|(([A-Z]{1}[a-z]*){1,}Error)|(ERROR)|(^\s\s*)/;
const INVEST_LOG_PREFIX = '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2},[0-9]{3}';
// e.g. '2020-10-16 07:13:04,325 (natcap.invest.carbon) INFO ...'

class LogDisplay extends React.Component {
  constructor(props) {
    super(props);
    this.content = React.createRef();
  }

  componentDidUpdate() {
    this.content.current.scrollTop = this.content.current.scrollHeight;
  }

  render() {
    /* Render log text as raw html to facilitate styling the plain text.
    This is dangerous, but made safer because the text is generated by
    natcap.invest, not by user-input, and because all text is passed
    through santize-html. */
    return (
      <Col id="log-display" ref={this.content}>
        <div
          id="log-text"
          dangerouslySetInnerHTML={{ __html: this.props.logdata }}
        />
      </Col>
    );
  }
}

LogDisplay.propTypes = {
  logdata: PropTypes.string,
};

/**
 * Encapsulate text in html, assigning class based on text content.
 *
 * @param  {string} line - plaintext string
 * @param  {object} patterns - of shape {string: RegExp}
 * @returns {string} - sanitized html
 */
function markupLine(line, patterns) {
  // eslint-disable-next-line
  for (const [cls, pattern] of Object.entries(patterns)) {
    if (pattern.test(line)) {
      const markup = `<${LOG_TEXT_TAG} class="${cls}">${line}</${LOG_TEXT_TAG}>`;
      return sanitizeHtml(markup, ALLOWED_HTML_OPTIONS);
    }
  }
  return sanitizeHtml(line, ALLOWED_HTML_OPTIONS);
}

export default class LogTab extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      logdata: null,
    };
    this.tail = null;
    this.logPatterns = {
      'invest-log-error': LOG_ERROR_REGEX,
      'invest-log-primary': new RegExp(this.props.pyModuleName),
    };

    this.tailLogfile = this.tailLogfile.bind(this);
    this.unwatchLogfile = this.unwatchLogfile.bind(this);
  }

  componentDidMount() {
    const { logfile, isRunning, jobID } = this.props;
    // This channel is replied to by the invest process stdout listener
    // And by the logfile reader.
    ipcRenderer.on(`invest-stdout-${jobID}`, (event, data) => {
      let { logdata } = this.state;
      logdata += markupLine(data, this.logPatterns);
      this.setState({ logdata: logdata });
    });
    if (!isRunning && logfile) {
      // this.tailLogfile(logfile);
      // const readLogChannel = `invest-read-log-${jobID}`;
      ipcRenderer.send(ipcMainChannels.INVEST_READ_LOG, logfile, jobID);
      // ipcRenderer.on(readLogChannel, (event, data) => {
      //   this.markupLogStream(data);
      // });
    }
  }

  componentDidUpdate(prevProps) {
    // If we're re-running a model after loading a recent run,
    // we should clear out the logdata when the new run is launched.
    if (this.props.isRunning && !prevProps.isRunning) {
      this.setState({ logdata: '' });
    }
  }

  componentWillUnmount() {
    // This does not trigger on browser window close
    if (this.tail) {
      this.unwatchLogfile();
    }
    ipcRenderer.removeAllListeners(`invest-stdout-${this.props.jobID}`);
  }

  tailLogfile(logfile) {
    try {
      if (process.platform === 'win32') {
        /* On Windows, node's `fs.watch` only reports back to node about the
         * logfile changing when the file is closed.  Python's FileHandler,
         * however, only closes the file when the logfile is closed at model
         * completion.  The workaround here is to use node's `fs.watchFile`,
         * which polls the modification times.  The interval here may need to
         * be tweaked.
         *
         * See experiment at
         * https://github.com/phargogh/experiment-windows-node-fs-watch
         * */
        this.tail = new Tail(logfile, {
          fromBeginning: true,
          useWatchFile: true,
          fsWatchOptions: {
            persistent: true,
            interval: 250, // .25s
          },
          logger: logger,
        });
      } else {
        /* All other OSes seem to report back as expected, so use `fs.watch` is
         * easier and cheaper. */
        this.tail = new Tail(logfile, {
          fromBeginning: true,
          logger: logger,
        });
      }
      let markup = Object.assign('', this.state.logdata);
      this.tail.on('line', (data) => {
        const line = `${data}${os.EOL}`;
        markup += markupLine(line, this.logPatterns);
        this.setState({ logdata: markup });
      });
      this.tail.on('error', (error) => {
        logger.error(error);
      });
    } catch (error) {
      this.setState({
        logdata: `Logfile is missing: ${os.EOL}${logfile}`
      });
      logger.error(`Not able to read ${logfile}`);
      logger.error(error.stack);
    }
  }

  unwatchLogfile() {
    try {
      logger.debug(`unwatching file: ${this.tail.filename}`);
      this.tail.unwatch();
    } catch (error) {
      logger.error(error.stack);
    }
  }

  render() {
    return (
      <Container fluid>
        <Row>
          <LogDisplay logdata={this.state.logdata} />
        </Row>
      </Container>
    );
  }
}

LogTab.propTypes = {
  logfile: PropTypes.string,
  isRunning: PropTypes.bool.isRequired,
  jobID: PropTypes.string.isRequired,
  pyModuleName: PropTypes.string.isRequired,
};
